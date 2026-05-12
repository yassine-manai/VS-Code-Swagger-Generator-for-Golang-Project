const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

function activate(context) {
  const disposable = vscode.commands.registerCommand('astroswag.generateSwagger', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No file is currently open!');
      return;
    }

    const filePath = editor.document.uri.fsPath;
    if (!filePath.endsWith('.go')) {
      vscode.window.showWarningMessage('AstroSwag only works on .go files!');
      return;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
      vscode.window.showErrorMessage('No workspace folder open!');
      return;
    }

    const rootPath = folders[0].uri.fsPath;
    const moduleDir = path.dirname(filePath);
    const moduleName = path.basename(moduleDir);

    const allGoFiles = findAllGoFiles(rootPath);
    const globalRouteMap = buildGlobalRouteMap(allGoFiles);

    if (Object.keys(globalRouteMap).length === 0) {
      vscode.window.showWarningMessage('AstroSwag: No routes found in project.');
      return;
    }

    const updated = injectAnnotations(filePath, globalRouteMap, moduleName);
    await vscode.commands.executeCommand('workbench.action.files.revert');

    vscode.window.showInformationMessage(
      `✅ AstroSwag: ${updated} annotation(s) updated in ${path.basename(filePath)}`
    );
  });

  const docDisposable = vscode.commands.registerCommand('astroswag.openDocumentation', () => {
    vscode.env.openExternal(vscode.Uri.parse('https://github.com/placeholder/astroswag#readme'));
  });

  context.subscriptions.push(disposable);
  context.subscriptions.push(docDisposable);
}

// ─── Find all .go files recursively ──────────────────────────────────────────
function findAllGoFiles(rootPath) {
  const files = [];
  function scan(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'vendor') {
        scan(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.go')) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  scan(rootPath);
  return files;
}

// ─── Build global route map ───────────────────────────────────────────────────
//
// Strategy:
//  1. Parse every .go file and collect:
//     - Group() definitions: varName -> { parent, localPath }  (local to each function)
//     - Route registrations: groupVar.METHOD("path", handler)
//     - Sub-router calls: SomePkgRoutes(groupVar, ...) or pkg.SomeRoutes(groupVar, ...)
//  2. Build a cross-file call graph:
//     funcName -> { prefix passed in, local groups, routes, sub-calls }
//  3. Walk the call graph from root functions (never called by anyone)
//     propagating resolved prefixes down the call chain.
//
function buildGlobalRouteMap(allGoFiles) {
  // Map: funcName -> { groups, routes, calls }
  const funcDefs = {};

  for (const file of allGoFiles) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); }
    catch { continue; }

    // Strip // comments
    const cleaned = content.replace(/\/\/[^\n]*/g, '');

    // Find all top-level function declarations and their bodies
    const funcDeclRe = /^func\s+([A-Za-z0-9_]+)\s*\(/gm;
    const positions = [];
    let m;
    while ((m = funcDeclRe.exec(cleaned)) !== null) {
      positions.push({ name: m[1], start: m.index });
    }

    for (let i = 0; i < positions.length; i++) {
      const funcName = positions[i].name;
      const start    = positions[i].start;
      const end      = positions[i + 1] ? positions[i + 1].start : cleaned.length;
      const body     = cleaned.slice(start, end);

      // ── 1. Group definitions: var := parentVar.Group("/path")
      const groups = {};
      const groupRe = /([A-Za-z0-9_]+)\s*:?=\s*([A-Za-z0-9_]+)\.Group\s*\(\s*"([^"]+)"\s*\)/g;
      while ((m = groupRe.exec(body)) !== null) {
        groups[m[1]] = { parent: m[2], localPath: m[3] };
      }

      // ── 2. Route registrations: groupVar.METHOD("path", [...pkg.]handler)
      const routes = [];
      const routeRe = /([A-Za-z0-9_]+)\.(GET|POST|PUT|DELETE|PATCH)\s*\(\s*"([^"]+)"\s*,\s*(?:[A-Za-z0-9_]+\.)*([A-Za-z0-9_]+)\s*[,)]/g;
      while ((m = routeRe.exec(body)) !== null) {
        routes.push({ groupVar: m[1], method: m[2].toLowerCase(), routePath: m[3], handlerName: m[4] });
      }

      // ── 3. Sub-router calls:
      //    pkg.SomeRoutes(groupVar, ...)   → cross-package call
      //    SomeRoutes(groupVar, ...)       → same-package call
      const calls = [];
      // Cross-package: pkg.FuncName(firstArg, ...)
      const crossCallRe = /[A-Za-z0-9_]+\.([A-Za-z][A-Za-z0-9_]*(?:Routes|Router|Handler|Init|Register|Setup)[A-Za-z0-9_]*)\s*\(\s*([A-Za-z0-9_]+)\s*[,)]/g;
      while ((m = crossCallRe.exec(body)) !== null) {
        calls.push({ calledFunc: m[1], groupVar: m[2] });
      }
      // Same-package: FuncName(firstArg, ...)  — must start uppercase
      const sameCallRe = /\b([A-Z][A-Za-z0-9_]*(?:Routes|Router|Handler|Init|Register|Setup)[A-Za-z0-9_]*)\s*\(\s*([A-Za-z0-9_]+)\s*[,)]/g;
      while ((m = sameCallRe.exec(body)) !== null) {
        calls.push({ calledFunc: m[1], groupVar: m[2] });
      }

      funcDefs[funcName] = { groups, routes, calls };
    }
  }

  // ── Find root functions: those never appearing as a calledFunc
  const calledSet = new Set();
  for (const { calls } of Object.values(funcDefs)) {
    for (const c of calls) calledSet.add(c.calledFunc);
  }

  // ── Propagate prefixes via BFS
  // resolvedPrefix[funcName][paramVar] = absolute prefix string
  // For root functions, all their group vars start relative to ""
  const resolvedPrefix = {}; // funcName -> prefix string passed into it

  for (const funcName of Object.keys(funcDefs)) {
    if (!calledSet.has(funcName)) {
      resolvedPrefix[funcName] = '';
    }
  }

  const queue = Object.keys(resolvedPrefix);
  const visited = new Set(queue);

  while (queue.length > 0) {
    const callerFunc = queue.shift();
    const incomingPrefix = resolvedPrefix[callerFunc] || '';
    const { groups, calls } = funcDefs[callerFunc] || { groups: {}, calls: [] };

    // Resolve local groups relative to incomingPrefix
    const resolvedGroups = resolveLocalGroups(incomingPrefix, groups);

    for (const call of calls) {
      if (visited.has(call.calledFunc)) continue;

      // The prefix passed to the called function is the resolved value of the groupVar
      const passedPrefix = resolvedGroups[call.groupVar] !== undefined
        ? resolvedGroups[call.groupVar]
        : incomingPrefix;

      resolvedPrefix[call.calledFunc] = passedPrefix;
      visited.add(call.calledFunc);
      queue.push(call.calledFunc);
    }
  }

  // ── Build final route map
  const globalRouteMap = {};

  for (const [funcName, { groups, routes }] of Object.entries(funcDefs)) {
    const incomingPrefix = resolvedPrefix[funcName] !== undefined
      ? resolvedPrefix[funcName]
      : '';

    const resolvedGroups = resolveLocalGroups(incomingPrefix, groups);

    for (const route of routes) {
      const groupPrefix = resolvedGroups[route.groupVar] !== undefined
        ? resolvedGroups[route.groupVar]
        : incomingPrefix;

      globalRouteMap[route.handlerName] = {
        method: route.method,
        route:  joinPaths(groupPrefix, route.routePath),
      };
    }
  }

  return globalRouteMap;
}

// ─── Resolve local group vars within a function ───────────────────────────────
// groups: { varName: { parent, localPath } }
// Returns: { varName: absolutePath }
function resolveLocalGroups(incomingPrefix, groups) {
  const resolved = {};
  const maxPasses = 20;

  for (let pass = 0; pass < maxPasses; pass++) {
    let progress = false;
    for (const [varName, { parent, localPath }] of Object.entries(groups)) {
      if (resolved[varName] !== undefined) continue;

      if (resolved[parent] !== undefined) {
        // Parent is a local group already resolved
        resolved[varName] = joinPaths(resolved[parent], localPath);
        progress = true;
      } else if (groups[parent] === undefined) {
        // Parent is the function's incoming router parameter
        resolved[varName] = joinPaths(incomingPrefix, localPath);
        progress = true;
      }
    }
    if (!progress) break;
  }

  return resolved;
}

// ─── Join paths cleanly ───────────────────────────────────────────────────────
function joinPaths(...parts) {
  const joined = parts
    .map(p => (p || '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return joined ? '/' + joined : '/';
}

// ─── Extract query params from handler function body ─────────────────────────
function extractQueryParams(funcBody) {
  const params = [];
  const seen = new Set();
  let match;

  const dqRe = /c\.DefaultQuery\s*\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\)/g;
  while ((match = dqRe.exec(funcBody)) !== null) {
    const name = match[1], defaultVal = match[2];
    if (!seen.has(name)) {
      seen.add(name);
      const goType = (defaultVal !== '' && !isNaN(Number(defaultVal))) ? 'int' : 'string';
      params.push({ name, goType, required: false, defaultVal });
    }
  }

  const qRe = /c\.Query\s*\(\s*"([^"]+)"\s*\)/g;
  while ((match = qRe.exec(funcBody)) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      params.push({ name, goType: 'string', required: false, defaultVal: '' });
    }
  }

  return params;
}

// ─── Extract path params from route string ────────────────────────────────────
function extractPathParams(route) {
  return [...route.matchAll(/:([a-zA-Z0-9_]+)/g)].map(m => ({
    name: m[1], goType: 'string', required: true, defaultVal: ''
  }));
}

// ─── Extract handler function body from file content ─────────────────────────
function extractHandlerBody(fileContent, funcName) {
  const re = new RegExp(`func\\s+(?:\\([^)]+\\)\\s+)?${funcName}\\s*\\([^)]*\\)[^{]*\\{`, 'g');
  const match = re.exec(fileContent);
  if (!match) return '';
  let depth = 0, i = match.index + match[0].length - 1;
  while (i < fileContent.length) {
    if (fileContent[i] === '{') depth++;
    else if (fileContent[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  return fileContent.slice(match.index, i + 1);
}

// ─── Inject / update annotations in handler file ──────────────────────────────
function injectAnnotations(handlerFile, routeMap, moduleName) {
  const content = fs.readFileSync(handlerFile, 'utf8');
  const lines = content.split('\n');
  const result = [];
  let updatedCount = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const funcMatch = line.match(/^func\s+(?:\([^)]+\)\s+)?([A-Z][A-Za-z0-9_]*)\s*\(/);

    if (funcMatch) {
      const funcName  = funcMatch[1];
      const routeInfo = routeMap[funcName];

      // Remove existing swagger comment block immediately above this function
      while (result.length > 0 && result[result.length - 1].trim().startsWith('//')) {
        result.pop();
      }

      if (routeInfo) {
        const funcBody    = extractHandlerBody(content, funcName);
        const pathParams  = extractPathParams(routeInfo.route);
        const queryParams = extractQueryParams(funcBody);
        const annotation  = buildAnnotation(funcName, moduleName, routeInfo, pathParams, queryParams);
        result.push(...annotation.split('\n'));
        updatedCount++;
      }
    }

    result.push(line);
    i++;
  }

  fs.writeFileSync(handlerFile, result.join('\n'), 'utf8');
  return updatedCount;
}

// ─── Build swagger annotation block ──────────────────────────────────────────
function buildAnnotation(funcName, moduleName, { method, route }, pathParams, queryParams) {
  const swaggerRoute = route.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');

  const pathParamLines = pathParams.map(p =>
    `//\t@Param\t\t\t${p.name}\tpath\t${p.goType}\ttrue\t"${p.name}"`
  );
  const queryParamLines = queryParams.map(p => {
    const def = p.defaultVal !== '' ? `\tdefault(${p.defaultVal})` : '';
    return `//\t@Param\t\t\t${p.name}\tquery\t${p.goType}\tfalse\t"${p.name}"${def}`;
  });

  const allParamLines = [...pathParamLines, ...queryParamLines].join('\n');

  return [
    `// ${funcName} godoc`,
    `//`,
    `//\t@Summary\t\t${funcName}`,
    `//\t@Description\t${funcName}`,
    `//\t@Tags\t\t\t${moduleName}`,
    `//\t@Accept\t\t\tjson`,
    `//\t@Produce\t\tjson`,
    allParamLines || null,
    `//\t@Security\t\tBearer`,
    `//\t@Success\t\t200\t{object}\tinterface{}`,
    `//\t@Failure\t\t400\t{object}\tutils.Response`,
    `//\t@Failure\t\t500\t{object}\tutils.Response`,
    `//\t@Router\t\t\t${swaggerRoute} [${method}]`,
  ].filter(Boolean).join('\n');
}

function deactivate() {}

module.exports = { activate, deactivate };