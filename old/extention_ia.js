const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY POINTS
// ═══════════════════════════════════════════════════════════════════════════════

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('astroswagger.generateSwagger', cmdGenerateSwagger),
    vscode.commands.registerCommand('astroswagger.openDocumentation', cmdOpenDocumentation),
  );
}

function deactivate() {}

async function cmdGenerateSwagger() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('astroswagger: No file is currently open.');
    return;
  }

  const filePath = editor.document.uri.fsPath;
  if (!filePath.endsWith('.go')) {
    vscode.window.showWarningMessage('astroswagger: Only works on .go files.');
    return;
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders) {
    vscode.window.showErrorMessage('astroswagger: No workspace folder open.');
    return;
  }

  const rootPath   = folders[0].uri.fsPath;
  const moduleName = path.basename(path.dirname(filePath));

  const allGoFiles   = collectGoFiles(rootPath);
  const globalRouteMap = buildRouteMap(allGoFiles);

  if (Object.keys(globalRouteMap).length === 0) {
    vscode.window.showWarningMessage('astroswagger: No gin routes found in this project.');
    return;
  }

  const updated = injectAnnotations(filePath, globalRouteMap, moduleName);
  await vscode.commands.executeCommand('workbench.action.files.revert');
  vscode.window.showInformationMessage(
    `✅ astroswagger: ${updated} annotation(s) updated in ${path.basename(filePath)}`
  );
}

function cmdOpenDocumentation() {
  vscode.env.openExternal(vscode.Uri.parse('https://github.com/placeholder/astroswagger#readme'));
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 0 — FILE COLLECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Recursively collect all .go files under rootPath,
 * skipping hidden directories and the vendor folder.
 *
 * @param {string} rootPath
 * @returns {string[]}
 */
function collectGoFiles(rootPath) {
  const files = [];

  function scan(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'vendor') {
          scan(path.join(dir, entry.name));
        }
      } else if (entry.isFile() && entry.name.endsWith('.go')) {
        files.push(path.join(dir, entry.name));
      }
    }
  }

  scan(rootPath);
  return files;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1 — PARSE ALL FILES INTO A CALL GRAPH
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A FuncInfo describes everything we need to know about one Go function:
 *
 *   params  — list of parameter names (positional)
 *   groups  — local Group() assignments: varName -> { parent, path }
 *   aliases — simple assignments between vars: varName -> sourceVar
 *   routes  — HTTP route registrations found inside this function
 *   calls   — calls to other functions that receive a gin var
 *
 * @typedef {{ parent: string, path: string }} GroupDef
 * @typedef {{ ginVar: string, method: string, routePath: string, handler: string }} RouteDef
 * @typedef {{ callee: string, ginArgIndex: number, ginVarName: string }} CallDef
 *
 * @typedef {{
 *   params:  string[],
 *   groups:  Record<string, GroupDef>,
 *   aliases: Record<string, string>,
 *   routes:  RouteDef[],
 *   calls:   CallDef[],
 * }} FuncInfo
 */

/**
 * Parse every .go file and build a map of funcName -> FuncInfo.
 *
 * @param {string[]} files
 * @returns {Record<string, FuncInfo>}
 */
function parseCallGraph(files) {
  /** @type {Record<string, FuncInfo>} */
  const graph = {};

  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { continue; }

    // Strip // line comments to avoid false regex matches inside comments.
    // Block comments (/* */) are rare in Go route files; skip for simplicity.
    const src = raw.replace(/\/\/[^\n]*/g, '');

    parseFunctions(src, graph);
  }

  return graph;
}

/**
 * Extract all top-level functions from a source string and populate graph.
 *
 * @param {string} src    — comment-stripped Go source
 * @param {Record<string, FuncInfo>} graph
 */
function parseFunctions(src, graph) {
  // Match both plain functions and method receivers:
  //   func FuncName(...)
  //   func (recv Type) FuncName(...)
  const funcDeclRe = /\bfunc\s+(?:\([^)]*\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g;
  const positions  = [];
  let m;

  while ((m = funcDeclRe.exec(src)) !== null) {
    positions.push({ name: m[1], paramStr: m[2], start: m.index });
  }

  for (let i = 0; i < positions.length; i++) {
    const { name, paramStr, start } = positions[i];
    const end  = positions[i + 1] ? positions[i + 1].start : src.length;
    const body = src.slice(start, end);

    const params      = parseParamNames(paramStr);
    const groups      = parseGroupDefs(body);
    const engineVars  = parseEngineVars(body);
    const aliases     = parseAliases(body);
    const routes      = parseRoutes(body);
    const calls       = parseCalls(body);

    // If a function with this name was already seen (overloaded across files),
    // merge rather than overwrite — take whichever has more information.
    if (graph[name]) {
      graph[name].routes.push(...routes);
      graph[name].calls.push(...calls);
      graph[name].engineVars.push(...engineVars);
      Object.assign(graph[name].groups,  groups);
      Object.assign(graph[name].aliases, aliases);
    } else {
      graph[name] = { params, groups, engineVars, aliases, routes, calls };
    }
  }
}

// ─── Parameter names ──────────────────────────────────────────────────────────

/**
 * Extract ordered parameter names from a Go parameter list string.
 * Handles: "r *gin.RouterGroup, db *bun.DB"  →  ["r", "db"]
 *
 * @param {string} paramStr
 * @returns {string[]}
 */
function parseParamNames(paramStr) {
  if (!paramStr.trim()) return [];

  return paramStr
    .split(',')
    .map(p => p.trim().split(/\s+/)[0])   // first token is the name
    .filter(n => n && /^[A-Za-z_]/.test(n));
}

// ─── Group definitions ────────────────────────────────────────────────────────

/**
 * Find all `varName := parentVar.Group("/path")` patterns.
 * Also handles `.Group("/path", middleware...)` — extra args are ignored.
 *
 * @param {string} body
 * @returns {Record<string, GroupDef>}
 */
function parseGroupDefs(body) {
  const groups = {};

  // varName :=  parentVar.Group( "/path" ...
  // varName  =  parentVar.Group( "/path" ...
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*([A-Za-z_][A-Za-z0-9_]*)\.Group\s*\(\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    groups[m[1]] = { parent: m[2], path: m[3] };
  }

  return groups;
}

// ─── Engine var assignments ───────────────────────────────────────────────────

/**
 * Find variables assigned from gin.New() or gin.Default().
 * These are the root gin vars seeded with prefix "".
 *
 *   r := gin.New()      →  ["r"]
 *   router := gin.Default() →  ["router"]
 *
 * @param {string} body
 * @returns {string[]}
 */
function parseEngineVars(body) {
  const vars = [];
  const re   = /([A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*gin\s*\.\s*(?:New|Default)\s*\(\s*\)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    vars.push(m[1]);
  }
  return vars;
}



/**
 * Find simple var-to-var assignments that could alias a gin group:
 *   api := v1
 *   protected = r
 *
 * @param {string} body
 * @returns {Record<string, string>}
 */
function parseAliases(body) {
  const aliases = {};

  // Must NOT be followed by a dot (would be a method call, handled elsewhere).
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:[^.(]|$)/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    // Exclude gin.New() / gin.Default() style — those are seeded separately
    aliases[m[1]] = m[2];
  }

  return aliases;
}

// ─── Route registrations ──────────────────────────────────────────────────────

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'Any'];

/**
 * Find all HTTP route registrations:
 *   ginVar.GET("/path", [...pkg.]HandlerFunc)
 *   ginVar.POST("/path", [...pkg.]HandlerFunc, ...)
 *
 * Anonymous handlers `func(c *gin.Context)` are skipped.
 *
 * @param {string} body
 * @returns {RouteDef[]}
 */
function parseRoutes(body) {
  const routes = [];
  const methodPattern = HTTP_METHODS.join('|');

  // ginVar.METHOD( "/path" ,  [pkg.]Handler
  const re = new RegExp(
    `([A-Za-z_][A-Za-z0-9_]*)\\.(${methodPattern})\\s*\\(\\s*"([^"]+)"\\s*,\\s*([^)]+)`,
    'g'
  );

  let m;
  while ((m = re.exec(body)) !== null) {
    const ginVar    = m[1];
    const method    = m[2].toLowerCase();
    const routePath = m[3];
    const handlerRaw = m[4].trim();

    // Extract the last identifier in the handler expression:
    //   handler.GetAuditsHandler  →  GetAuditsHandler
    //   GetAuditsHandler          →  GetAuditsHandler
    //   h.Get                     →  Get
    // Skip anonymous functions
    if (handlerRaw.startsWith('func')) continue;

    const handlerMatch = handlerRaw.match(/(?:[A-Za-z_][A-Za-z0-9_]*\.)*([A-Za-z_][A-Za-z0-9_]*)/);
    if (!handlerMatch) continue;

    routes.push({ ginVar, method, routePath, handler: handlerMatch[1] });
  }

  return routes;
}

// ─── Sub-router calls ─────────────────────────────────────────────────────────

/**
 * Find any function call where one of the arguments is a known-looking
 * identifier that could be a gin var.  We record:
 *   - the callee name (last segment of pkg.Func or just Func)
 *   - the index of each argument (so we can match to the callee's param list)
 *   - the name of the var passed
 *
 * We emit one CallDef per argument — the BFS will filter to gin vars later.
 *
 * @param {string} body
 * @returns {CallDef[]}
 */
function parseCalls(body) {
  const calls = [];

  // Match:  [pkg.]FuncName( arg0, arg1, arg2 )
  // We capture the argument list as a raw string and split it.
  const re = /(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g;
  let m;

  while ((m = re.exec(body)) !== null) {
    const callee  = m[1];
    const argStr  = m[2].trim();
    if (!argStr) continue;

    // Split on commas not inside nested parens/brackets (simple heuristic)
    const args = splitArgs(argStr);

    for (let i = 0; i < args.length; i++) {
      const arg = args[i].trim();
      // Only track simple identifiers (not expressions) as potential gin vars
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) {
        calls.push({ callee, ginArgIndex: i, ginVarName: arg });
      }
    }
  }

  return calls;
}

/**
 * Split a comma-separated argument string, respecting nested parens.
 *
 * @param {string} str
 * @returns {string[]}
 */
function splitArgs(str) {
  const args  = [];
  let depth   = 0;
  let current = '';

  for (const ch of str) {
    if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; }
    else if (ch === ')' || ch === ']' || ch === '}') { depth--; current += ch; }
    else if (ch === ',' && depth === 0) { args.push(current); current = ''; }
    else { current += ch; }
  }

  if (current.trim()) args.push(current);
  return args;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2 — RESOLVE PREFIXES VIA BFS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Walk the call graph with BFS, propagating resolved gin prefixes.
 *
 * Seed: functions that create a gin engine directly via gin.New() / gin.Default().
 * For every function, we maintain a map of  varName -> absolutePrefix.
 *
 * @param {Record<string, FuncInfo>} graph
 * @returns {Record<string, string>}   handlerName -> { method, route }
 */
function buildRouteMap(allGoFiles) {
  const graph = parseCallGraph(allGoFiles);

  // resolvedVars[funcName] = { varName -> absolutePrefix }
  /** @type {Record<string, Record<string, string>>} */
  const resolvedVars = {};

  // ── Seed: find root functions — those that create gin vars directly
  //    (gin.New / gin.Default) and are not called by anyone else.
  //
  // Functions called by others get their prefix from BFS propagation.
  // Functions with gin.New() are true entry points — seeded with "".
  //
  const calledFuncs = new Set();
  for (const info of Object.values(graph)) {
    for (const call of info.calls) calledFuncs.add(call.callee);
  }

  for (const [funcName, info] of Object.entries(graph)) {
    // Seed any function that has engine vars (gin.New/gin.Default)
    if ((info.engineVars || []).length > 0) {
      resolvedVars[funcName] = buildLocalVars({}, info);
      continue;
    }

    // Also seed functions that have group defs but are never called —
    // they may be entry points that receive *gin.Engine from a framework
    // or test setup that we couldn't trace.
    if (!calledFuncs.has(funcName) && Object.keys(info.groups).length > 0) {
      const localVars = buildLocalVars({}, info);
      if (Object.keys(localVars).length > 0) {
        resolvedVars[funcName] = localVars;
      }
    }
  }

  // ── BFS over the call graph
  const queue   = Object.keys(resolvedVars);
  const visited = new Set(queue);

  while (queue.length > 0) {
    const callerName = queue.shift();
    const callerInfo = graph[callerName];
    if (!callerInfo) continue;

    // Build the full local var map for this function
    const localVars = buildLocalVars(
      resolvedVars[callerName] || {},
      callerInfo
    );

    // Propagate into every call this function makes
    for (const call of callerInfo.calls) {
      // Is the var being passed a known gin var in this scope?
      if (!(call.ginVarName in localVars)) continue;

      const passedPrefix = localVars[call.ginVarName];
      const calleeInfo   = graph[call.callee];
      if (!calleeInfo) continue;

      // Map the argument position to the callee's parameter name
      const paramName = calleeInfo.params[call.ginArgIndex];
      if (!paramName) continue;

      if (!visited.has(call.callee)) {
        resolvedVars[call.callee] = { [paramName]: passedPrefix };
        visited.add(call.callee);
        queue.push(call.callee);
      } else {
        // Already visited — merge in case it's called from multiple parents
        resolvedVars[call.callee] = resolvedVars[call.callee] || {};
        if (!(paramName in resolvedVars[call.callee])) {
          resolvedVars[call.callee][paramName] = passedPrefix;
        }
      }
    }
  }

  // ── Collect all routes into the final map
  /** @type {Record<string, { method: string, route: string }>} */
  const routeMap = {};

  for (const [funcName, info] of Object.entries(graph)) {
    if (info.routes.length === 0) continue;

    const localVars = buildLocalVars(
      resolvedVars[funcName] || {},
      info
    );

    for (const route of info.routes) {
      const prefix    = localVars[route.ginVar] ?? '';
      const fullRoute = joinPaths(prefix, route.routePath);

      routeMap[route.handler] = { method: route.method, route: fullRoute };
    }
  }

  return routeMap;
}

// ─── Local var resolution ─────────────────────────────────────────────────────

/**
 * Build the complete gin-var map for a function given:
 *   - seedVars: { paramName -> absolutePrefix }  (from BFS propagation)
 *   - info: the function's parsed data
 *
 * Resolves group chains and aliases iteratively.
 *
 * @param {Record<string, string>} seedVars
 * @param {FuncInfo} info
 * @returns {Record<string, string>}
 */
function buildLocalVars(seedVars, info) {
  /** @type {Record<string, string>} */
  const vars = { ...seedVars };

  // Seed vars from gin.New() / gin.Default() with prefix ""
  for (const varName of (info.engineVars || [])) {
    if (!(varName in vars)) vars[varName] = '';
  }

  // Fallback: if a Group()'s parent is not in vars and not a local group,
  // it must be a gin.Engine/*gin.RouterGroup param we haven't seen — seed as "".
  // This handles cases where the param type wasn't captured (e.g. *gin.Engine
  // passed in from a caller we couldn't trace).
  for (const def of Object.values(info.groups)) {
    if (!(def.parent in vars) && !(def.parent in info.groups)) {
      vars[def.parent] = '';
    }
  }

  // Iteratively resolve groups and aliases until stable
  const MAX_PASSES = 30;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;

    // Resolve .Group() definitions
    for (const [varName, def] of Object.entries(info.groups)) {
      if (varName in vars) continue;
      if (def.parent in vars) {
        vars[varName] = joinPaths(vars[def.parent], def.path);
        changed = true;
      }
    }

    // Resolve simple aliases (api := v1)
    for (const [varName, source] of Object.entries(info.aliases)) {
      if (varName in vars) continue;
      if (source in vars) {
        vars[varName] = vars[source];
        changed = true;
      }
    }

    if (!changed) break;
  }

  return vars;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3 — ANNOTATION INJECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Read a handler .go file, inject or replace swagger godoc blocks above
 * every exported handler function that exists in routeMap.
 *
 * @param {string} filePath
 * @param {Record<string, { method: string, route: string }>} routeMap
 * @param {string} moduleName
 * @returns {number} number of annotations written
 */
async function injectAnnotations(filePath, routeMap, moduleName) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines   = content.split('\n');
  const output  = [];
  let updated   = 0;
  let i         = 0;

  // ── First pass: collect all handlers that need annotations ──────────────────
  /** @type {Array<{ funcName: string, lineIndex: number, routeInfo: object, body: string }>} */
  const handlers = [];

  while (i < lines.length) {
    const funcMatch = lines[i].match(/^func\s+(?:\([^)]+\)\s+)?([A-Z][A-Za-z0-9_]*)\s*\(/);
    if (funcMatch) {
      const funcName  = funcMatch[1];
      const routeInfo = routeMap[funcName];
      if (routeInfo) {
        handlers.push({
          funcName,
          lineIndex: i,
          routeInfo,
          body: extractFuncBody(content, funcName),
        });
      }
    }
    i++;
  }

  // ── Second pass: build all annotations in parallel (AI calls run concurrently)
  const annotations = await Promise.all(
    handlers.map(({ funcName, routeInfo, body }) =>
      buildAnnotation(funcName, moduleName, routeInfo, body)
    )
  );

  // ── Third pass: inject annotations into the line array ───────────────────────
  // Build a map of lineIndex -> annotation string for O(1) lookup
  const annotationMap = new Map(
    handlers.map((h, idx) => [h.lineIndex, annotations[idx]])
  );

  i = 0;
  while (i < lines.length) {
    const line      = lines[i];
    const funcMatch = line.match(/^func\s+(?:\([^)]+\)\s+)?([A-Z][A-Za-z0-9_]*)\s*\(/);

    if (funcMatch && annotationMap.has(i)) {
      // Strip any existing swagger comment block directly above this function
      while (output.length > 0 && output[output.length - 1].trim().startsWith('//')) {
        output.pop();
      }
      output.push(...annotationMap.get(i).split('\n'));
      updated++;
    }

    output.push(line);
    i++;
  }

  fs.writeFileSync(filePath, output.join('\n'), 'utf8');
  return updated;
}

// ─── Extract function body ────────────────────────────────────────────────────

/**
 * Find the body of a named function in source by counting braces.
 *
 * @param {string} src
 * @param {string} funcName
 * @returns {string}
 */
function extractFuncBody(src, funcName) {
  const re = new RegExp(
    `\\bfunc\\s+(?:\\([^)]+\\)\\s+)?${funcName}\\s*\\([^)]*\\)[^{]*\\{`, 'g'
  );
  const match = re.exec(src);
  if (!match) return '';

  let depth = 0;
  let i     = match.index + match[0].length - 1;

  while (i < src.length) {
    if (src[i] === '{')      depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }

  return src.slice(match.index, i + 1);
}

// ─── Param extraction ─────────────────────────────────────────────────────────

/**
 * Extract :param segments from a route path.
 *
 * @param {string} route
 */
function extractPathParams(route) {
  return [...route.matchAll(/:([a-zA-Z0-9_]+)/g)].map(m => ({
    name: m[1], goType: 'string', required: true,
  }));
}

/**
 * Extract query params from c.Query() and c.DefaultQuery() calls in a handler body.
 *
 * @param {string} body
 */
function extractQueryParams(body) {
  const params = [];
  const seen   = new Set();
  let match;

  // c.DefaultQuery("name", "default")
  const dqRe = /c\.DefaultQuery\s*\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\)/g;
  while ((match = dqRe.exec(body)) !== null) {
    const name = match[1], def = match[2];
    if (seen.has(name)) continue;
    seen.add(name);
    const goType = (def !== '' && !isNaN(Number(def))) ? 'int' : 'string';
    params.push({ name, goType, required: false, defaultVal: def });
  }

  // c.Query("name")
  const qRe = /c\.Query\s*\(\s*"([^"]+)"\s*\)/g;
  while ((match = qRe.exec(body)) !== null) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    params.push({ name, goType: 'string', required: false, defaultVal: '' });
  }

  return params;
}

/**
 * Detect request body binding and extract the struct type name.
 *
 * Matches patterns like:
 *   utils.BindJSON(c, &request)         → looks up var type → "CreateSettingRequest"
 *   c.ShouldBindJSON(&req)              → looks up var type → "UpdateUserRequest"
 *   var body CreateSettingRequest       → directly typed   → "CreateSettingRequest"
 *   request := CreateSettingRequest{}   → directly typed   → "CreateSettingRequest"
 *
 * @param {string} body   — raw handler source
 * @returns {string|null} struct type name, or null if no body binding found
 */
function extractBodyParam(body) {
  // ── Pattern 1: var <name> <StructType>
  //   var request CreateSettingRequest
  const varDeclRe = /\bvar\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Z][A-Za-z0-9_]*)\b/g;
  let m;
  while ((m = varDeclRe.exec(body)) !== null) {
    const typeName = m[2];
    // Check this var is actually used in a bind call
    const varName  = m[1];
    if (isUsedInBind(body, varName)) return typeName;
  }

  // ── Pattern 2: <name> := <StructType>{}
  //   request := CreateSettingRequest{}
  const shortDeclRe = /([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([A-Z][A-Za-z0-9_]*)\s*\{/g;
  while ((m = shortDeclRe.exec(body)) !== null) {
    const varName  = m[1];
    const typeName = m[2];
    if (isUsedInBind(body, varName)) return typeName;
  }

  // ── Pattern 3: bind call with &<name> where we can infer the type
  //   from nearby declarations — extract just the struct name from any bind call
  //   as a last resort by looking for &<VarName> and finding its type anywhere in body
  const bindRe = /(?:BindJSON|ShouldBindJSON|ShouldBind|BindWith|Bind)\s*\(\s*(?:c\s*,\s*)?&([A-Za-z_][A-Za-z0-9_]*)/g;
  while ((m = bindRe.exec(body)) !== null) {
    const varName = m[1];
    // Try to find any type declaration for this var in the body
    const typeRe = new RegExp(`\\b${varName}\\b[^=]*[:=][^=]\\s*([A-Z][A-Za-z0-9_]*)`, 'g');
    const tm = typeRe.exec(body);
    if (tm) return tm[1];
  }

  return null;
}

/**
 * Returns true if varName appears in a bind/decode call in the body.
 *
 * @param {string} body
 * @param {string} varName
 * @returns {boolean}
 */
function isUsedInBind(body, varName) {
  const re = new RegExp(
    `(?:BindJSON|ShouldBindJSON|ShouldBind|BindWith|Bind|Decode)\\s*\\([^)]*&${varName}\\b`
  );
  return re.test(body);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 4 — ANNOTATION GENERATION  (Static inference + AI description)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a complete swaggo godoc annotation block for one handler.
 * Summary is always static (instant).
 * Description tries Claude API first, falls back to static if it fails/times out.
 *
 * @param {string} funcName
 * @param {string} moduleName
 * @param {{ method: string, route: string }} routeInfo
 * @param {string} body   — raw handler function source
 * @returns {Promise<string>}
 */
async function buildAnnotation(funcName, moduleName, { method, route }, body) {
  const swaggerRoute = route.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
  const pathParams   = extractPathParams(route);
  const queryParams  = extractQueryParams(body);
  const bodyType     = extractBodyParam(body);   // null if no request body

  const summary     = staticSummary(funcName, method, route);
  const description = await aiDescription(funcName, method, route, body)
                        .catch(() => staticDescription(funcName, method, route, pathParams, queryParams));

  const pathLines = pathParams.map(p =>
    `//\t@Param\t\t\t${p.name}\tpath\t${p.goType}\ttrue\t"${p.name}"`
  );
  const queryLines = queryParams.map(p => {
    const def = p.defaultVal !== '' ? `\tdefault(${p.defaultVal})` : '';
    return `//\t@Param\t\t\t${p.name}\tquery\t${p.goType}\tfalse\t"${p.name}"${def}`;
  });
  // Body param line: @Param body body StructType true "Request body"
  const bodyLine = bodyType
    ? `//\t@Param\t\t\tbody\tbody\t${bodyType}\ttrue\t"Request body"`
    : null;

  const paramLines = [...pathLines, ...queryLines, bodyLine].filter(Boolean).join('\n');

  return [
    `// ${funcName} godoc`,
    `//`,
    `//\t@Summary\t\t${summary}`,
    `//\t@Description\t${description}`,
    `//\t@Tags\t\t\t${moduleName}`,
    `//\t@Accept\t\t\tjson`,
    `//\t@Produce\t\tjson`,
    paramLines || null,
    `//\t@Security\t\tBearer`,
    `//\t@Success\t\t200\t{object}\tinterface{}`,
    `//\t@Failure\t\t400\t{object}\tutils.Response`,
    `//\t@Failure\t\t500\t{object}\tutils.Response`,
    `//\t@Router\t\t\t${swaggerRoute} [${method}]`,
  ].filter(Boolean).join('\n');
}

// ─── Static summary ───────────────────────────────────────────────────────────

/**
 * Generate a human-readable one-line summary from the function name and route.
 *
 * GetAuditByIDHandler  + GET  /audits/:id  →  "Retrieve audit by ID"
 * ExportAuditHandler   + POST /audits/export  →  "Export audit"
 * ListUsersHandler     + GET  /users          →  "List users"
 *
 * @param {string} funcName
 * @param {string} method
 * @param {string} route
 * @returns {string}
 */
function staticSummary(funcName, method, route) {
  // ── 1. Split camelCase into tokens, drop trailing noise words
  const noiseWords  = new Set(['handler', 'controller', 'api', 'endpoint', 'func', 'action']);
  const tokens      = splitCamelCase(funcName).filter(t => !noiseWords.has(t.toLowerCase()));

  // ── 2. Map the first token (verb) to a clean action word
  //       Fall back to HTTP method semantics if no verb recognized
  const verbMap = {
    get:      'Retrieve', fetch:  'Retrieve', find:   'Retrieve', read: 'Retrieve',
    list:     'List',     getall: 'List',     fetchall: 'List',
    create:   'Create',   add:    'Create',   new:    'Create',   register: 'Create',
    update:   'Update',   edit:   'Update',   modify: 'Update',   patch: 'Update',
    delete:   'Delete',   remove: 'Delete',   destroy: 'Delete',
    export:   'Export',
    import:   'Import',
    upload:   'Upload',
    download: 'Download',
    send:     'Send',
    check:    'Check',
    validate: 'Validate',
    search:   'Search',
    count:    'Count',
    login:    'Login',
    logout:   'Logout',
    refresh:  'Refresh',
    verify:   'Verify',
    approve:  'Approve',
    reject:   'Reject',
    assign:   'Assign',
    revoke:   'Revoke',
  };

  const methodFallback = {
    get: 'Retrieve', post: 'Create', put: 'Update',
    patch: 'Update', delete: 'Delete',
  };

  let action      = '';
  let resourceTokens = tokens;

  if (tokens.length > 0) {
    const first = tokens[0].toLowerCase();
    if (verbMap[first]) {
      action         = verbMap[first];
      resourceTokens = tokens.slice(1);
    }
  }

  if (!action) action = methodFallback[method] || 'Process';

  // ── 3. Build resource string from remaining tokens
  //       "By" + next token → append "by <token>" qualifier
  let resource  = '';
  let qualifier = '';

  for (let i = 0; i < resourceTokens.length; i++) {
    const t = resourceTokens[i];
    if (t.toLowerCase() === 'by' && i + 1 < resourceTokens.length) {
      qualifier = 'by ' + resourceTokens.slice(i + 1).join(' ').toLowerCase();
      break;
    }
    resource += (resource ? ' ' : '') + t.toLowerCase();
  }

  // ── 4. If route has :param, ensure "by <param>" is present
  const pathParams = [...route.matchAll(/:([a-zA-Z0-9_]+)/g)].map(m => m[1]);
  if (pathParams.length > 0 && !qualifier) {
    qualifier = 'by ' + pathParams[pathParams.length - 1].replace(/_/g, ' ');
  }

  const parts = [action, resource, qualifier].filter(Boolean);
  return parts.join(' ').trim() || funcName;
}

/**
 * Split a camelCase or PascalCase identifier into words.
 * "GetAuditByIDHandler" → ["Get", "Audit", "By", "ID"]
 *
 * @param {string} name
 * @returns {string[]}
 */
function splitCamelCase(name) {
  return name
    // Insert space before a capital followed by lowercase (AuditBy → Audit By)
    .replace(/([A-Z][a-z])/g, ' $1')
    // Insert space before a capital preceded by lowercase (IDHandler → ID Handler)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // Insert space before a run of capitals followed by a capital+lowercase (APIKey → API Key)
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// ─── Static description (fallback) ───────────────────────────────────────────

/**
 * Generate a fallback description when the AI call fails.
 * More detailed than the summary — includes params and auth note.
 *
 * @param {string} funcName
 * @param {string} method
 * @param {string} route
 * @param {Array}  pathParams
 * @param {Array}  queryParams
 * @returns {string}
 */
function staticDescription(funcName, method, route, pathParams, queryParams) {
  const summary  = staticSummary(funcName, method, route);
  const parts    = [summary + '.'];

  if (pathParams.length > 0) {
    const names = pathParams.map(p => p.name).join(', ');
    parts.push(`Requires path parameter(s): ${names}.`);
  }

  if (queryParams.length > 0) {
    const names = queryParams.map(p => p.name).join(', ');
    parts.push(`Supports query filters: ${names}.`);
  }

  parts.push('Requires Bearer authentication.');
  return parts.join(' ');
}

// ─── AI description via Claude API ───────────────────────────────────────────

/** How long to wait for the Claude API before falling back to static. */
const AI_TIMEOUT_MS = 4000;

/**
 * Call the Claude API to generate a descriptive OpenAPI description
 * for the given handler function.
 * Rejects if the API call takes longer than AI_TIMEOUT_MS.
 *
 * @param {string} funcName
 * @param {string} method
 * @param {string} route
 * @param {string} body   — raw handler source (trimmed to 1200 chars)
 * @returns {Promise<string>}
 */
async function aiDescription(funcName, method, route, body) {
  const trimmedBody = body.length > 1200 ? body.slice(0, 1200) + '\n  // ...' : body;

  const prompt = [
    `You are an OpenAPI documentation writer for Go/Gin REST APIs.`,
    `Write a concise description (1-2 sentences, plain English) for the handler below.`,
    `Focus on: what resource it operates on, what it does, notable filters or side effects.`,
    `Do NOT mention authentication, error codes, or implementation details.`,
    `Reply with ONLY the description text. No preamble, no bullet points, no markdown.`,
    ``,
    `Handler: ${funcName}`,
    `HTTP: ${method.toUpperCase()} ${route}`,
    ``,
    `Source:`,
    trimmedBody,
  ].join('\n');

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('AI timeout')), AI_TIMEOUT_MS)
  );

  const apiPromise = fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 120,
      messages:   [{ role: 'user', content: prompt }],
    }),
  })
  .then(res => {
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return res.json();
  })
  .then(data => {
    const text = data?.content?.find(b => b.type === 'text')?.text?.trim();
    if (!text) throw new Error('Empty AI response');
    // Collapse any newlines the model snuck in
    return text.replace(/\s*\n\s*/g, ' ').trim();
  });

  return Promise.race([apiPromise, timeoutPromise]);
}


// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Join URL path segments, ensuring exactly one slash between each segment
 * and a leading slash on the result.
 *
 * @param {...string} parts
 * @returns {string}
 */
function joinPaths(...parts) {
  const joined = parts
    .map(p => (p || '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return joined ? '/' + joined : '/';
}

// ═══════════════════════════════════════════════════════════════════════════════

module.exports = { activate, deactivate };