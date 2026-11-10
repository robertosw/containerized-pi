import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'core.dart';
import 'resolve.dart';
import 'util.dart';

mixin Queries on CoreBase {
  // ------------------------------------------------------------------------
  // references
  // ------------------------------------------------------------------------
  Future<String> references(Map<String, dynamic> p) async {
    final symbol = p['symbol'] as String;
    final includeExternal = p['includeExternal'] as bool? ?? false;
    final res = await _resolve(p);
    await openPath(res.path);
    final result = await lspCall(
      'textDocument/references',
      {
        'textDocument': {'uri': fileUri(res.path)},
        'position': res.pos.toJson(),
        'context': {'includeDeclaration': true},
      },
    ) as List?;
    final lines = <String>[];
    final entryIndex = <int>[];
    var skippedExternal = 0;
    final byFile = <String, List<(int, String)>>{};
    for (final r in result ?? []) {
      final uri = (r as Map<String, dynamic>)['uri'] as String;
      final path = uriPath(uri);
      final range = parseRange((r['range'] as Map<String, dynamic>));
      if (!isInsideWorkspace(path) && !includeExternal) {
        skippedExternal++;
        continue;
      }
      final src = lineAt(path, range.start.line) ?? '';
      byFile.putIfAbsent(rel(path), () => []).add(
          (range.start.line + 1, src.trim()));
    }
    var n = 0;
    final files = byFile.keys.toList()..sort();
    for (final f in files) {
      final refs = byFile[f]!..sort((a, b) => a.$1.compareTo(b.$1));
      lines.add(f);
      entryIndex.add(0);
      for (final r in refs) {
        lines.add('  ${r.$1}: ${r.$2}');
        entryIndex.add(++n);
      }
    }
    final header = 'references for $symbol: $n';
    var text = budgeted(
        header: header, lines: lines, entryIndex: entryIndex, budget: 50);
    if (skippedExternal > 0) {
      text += '\n($skippedExternal external reference(s) hidden; pass includeExternal: true)';
    }
    return text;
  }

  // ------------------------------------------------------------------------
  // definition
  // ------------------------------------------------------------------------
  Future<String> definition(Map<String, dynamic> p) async {
    final symbol = p['symbol'] as String;
    final res = await _resolve(p);
    await openPath(res.path);
    final result = await lspCall(
      'textDocument/definition',
      {
        'textDocument': {'uri': fileUri(res.path)},
        'position': res.pos.toJson(),
      },
    );
    if (result == null || (result as List).isEmpty) {
      return 'no definition found for $symbol at ${rel(res.path)}:${res.declLine + 1}';
    }
    final first = result.first as Map<String, dynamic>;
    final uri = (first.containsKey('targetUri') ? first['targetUri'] : first['uri']) as String;
    final path = uriPath(uri);
    final range = parseRange((first.containsKey('targetRange')
            ? first['targetRange']
            : first['range']) as Map<String, dynamic>);
    await openPath(path);
    final lines = linesOf(path);
    final out = <String>[rel(path)];
    // Find the documentSymbol entry whose selection contains this position:
    // its range is the full declaration (the definition range may be just the
    // name selection).
    Map<String, dynamic>? node;
    LspRange? nodeMapRange;
    try {
      final docResult = await lspCall(
        'textDocument/documentSymbol',
        {'textDocument': {'uri': fileUri(path)}},
      ) as List?;
      _findNode(docResult ?? [], range.start, (n) {
        node = n;
        nodeMapRange = parseRange((n['range'] as Map<String, dynamic>));
      });
    } catch (_) {}
    final nodeMap = node;
    final decl = nodeMapRange ?? range;
    final doc = docCommentBefore(lines, decl.start.line, maxLines: 3);
    out.addAll(doc);
    final height = decl.end.line - decl.start.line + 1;
    if (nodeMap != null && height > 80) {
      out.add(lineAt(path, decl.start.line)?.trim() ?? '');
      final children = (nodeMap['children'] as List?) ?? [];
      for (final c in children) {
        final cm = c as Map<String, dynamic>;
        final cs = parseRange(cm['selectionRange'] as Map<String, dynamic>);
        final sig = lineAt(path, parseRange(cm['range'] as Map<String, dynamic>).start.line);
        out.add('  ${sig?.trim() ?? cs.start.pos}');
      }
      out.add('  } // ${height} lines total');
    } else {
      final end = decl.end.line > decl.start.line + 80
          ? decl.start.line + 80
          : decl.end.line;
      out.addAll(lines.sublist(decl.start.line, end + 1));
    }
    return out.join('\n');
  }

  void _findNode(List items, LspPos start, void Function(Map<String, dynamic>) set) {
    for (final it in items) {
      final m = it as Map<String, dynamic>;
      final sel = parseRange(m['selectionRange'] as Map<String, dynamic>);
      if (sel.start == start || sel.containsPos(start)) {
        set(m);
        return;
      }
      final children = (m['children'] as List?) ?? [];
      _findNode(children, start, set);
    }
  }

  // ------------------------------------------------------------------------
  // outline
  // ------------------------------------------------------------------------
  Future<String> outline(Map<String, dynamic> p) async {
    final path = resolveFileHint((p['file'] as String));
    await openPath(path);
    final result = await lspCall(
      'textDocument/documentSymbol',
      {'textDocument': {'uri': fileUri(path)}},
    ) as List?;
    final lines = linesOf(path);
    final out = <String>[rel(path)];
    if (result == null || result.isEmpty) {
      out.add('(no symbols)');
      return out.join('\n');
    }
    _renderSymbols(result, 0, out, lines);
    return out.join('\n');
  }

  void _renderSymbols(List items, int depth, List<String> out, List<String> lines) {
    final indent = '  ' * depth;
    for (final it in items) {
      final m = it as Map<String, dynamic>;
      final range = parseRange(m['range'] as Map<String, dynamic>);
      final name = m['name'] as String;
      final kind = (m['kind'] as num?)?.toInt();
      out.add('$indent$name (${symbolKindName(kind)})');
      final doc = docCommentBefore(lines, range.start.line, maxLines: 3);
      for (final d in doc) {
        out.add('$indent  /// ${d}');
      }
      final sig = lines[range.start.line].trim();
      out.add('$indent  $sig');
      final children = (m['children'] as List?) ?? [];
      _renderSymbols(children, depth + 1, out, lines);
    }
  }

  static String symbolKindName(int? k) {
    switch (k) {
      case 5:
        return 'class';
      case 6:
        return 'method';
      case 7:
        return 'property';
      case 8:
        return 'field';
      case 9:
        return 'constructor';
      case 10:
        return 'enum';
      case 11:
        return 'interface';
      case 12:
        return 'struct';
      case 13:
        return 'type';
      case 14:
        return 'function';
      case 15:
        return 'variable';
      case 16:
        return 'constant';
      case 17:
        return 'string';
      case 18:
        return 'number';
      case 20:
        return 'operator';
      case 22:
        return 'package';
      case 23:
        return 'namespace';
      case 24:
        return 'module';
      case 25:
        return 'getter';
      case 26:
        return 'setter';
      case 27:
        return 'mixin';
      default:
        return 'symbol';
    }
  }

  // ------------------------------------------------------------------------
  // hierarchy
  // ------------------------------------------------------------------------
  Future<String> hierarchy(Map<String, dynamic> p) async {
    final symbol = p['symbol'] as String;
    final depth = (p['depth'] as num?)?.toInt() ?? 2;
    final includeExternal = p['includeExternal'] as bool? ?? false;
    final res = await _resolve(p);
    await openPath(res.path);
    final preparedRaw = await lspCall(
      'textDocument/prepareTypeHierarchy',
      {'textDocument': {'uri': fileUri(res.path)}, 'position': res.pos.toJson()},
    );
    if (preparedRaw == null || (preparedRaw as List).isEmpty) {
      return 'no type hierarchy for $symbol at ${rel(res.path)}:${res.declLine + 1}';
    }
    final item = preparedRaw.first as Map<String, dynamic>;
    final itemName = item['name'] as String;
    final itemUri = item['uri'] as String;
    final isType = itemName == symbol;

    final out = <String>[];
    if (isType) {
      final itemSel = parseRange(item['selectionRange'] as Map<String, dynamic>);
      // Supertype chain: always complete, external included.
      out.add('$symbol (type)');
      out.add('supertypes:');
      final chain = <String>[symbol];
      var cur = item;
      var guard = 0;
      while (guard++ < 50) {
        final sups = await lspCall(
          'typeHierarchy/supertypes',
          {'item': cur},
        ) as List?;
        if (sups == null || sups.isEmpty) break;
        cur = sups.first as Map<String, dynamic>;
        chain.add(_typeNameLine(cur, includeExternal: true));
      }
      out.addAll(['  ${chain.join('  ←  ')}']);
      // Subtype tree.
      final sealed = _isSealed(item);
      final maxDepth = sealed ? 99 : depth;
      out.add('subtypes (${sealed ? 'sealed, complete tree' : 'depth $depth'}):');
      var subtypeCount = 0;
      var subtypeCut = false;
      await _subtypeTree(item, 1, maxDepth, out, (path) {
        if (subtypeCount++ >= 30) {
          subtypeCut = true;
          return true;
        }
        return false;
      }, includeExternal);
      if (subtypeCut) out.add('  [truncated at 30 subtypes]');
      // References (exhaustive-switch blast radius).
      final refs = await _typeReferences(itemUri, itemSel, includeExternal);
      out.add('');
      out.add(refs);
      return out.join('\n');
    }

    // Member query.
    out.add('$symbol (member of $itemName)');
    out.add('overrides (super chain):');
    try {
      final supers = await lspCall(
        'dart/textDocument/super',
        {
          'textDocument': {'uri': fileUri(res.path)},
          'position': res.pos.toJson(),
        },
      );
      final list = (supers as List?) ?? [];
      if (list.isEmpty) {
        out.add('  (none)');
      }
      for (final s in list) {
        final sm = s as Map<String, dynamic>;
        final su = sm['uri'] as String? ?? '';
        final spath = su.isEmpty ? '' : uriPath(su);
        final srange =
            (sm['range'] as Map<String, dynamic>?) != null
                ? parseRange(sm['range'] as Map<String, dynamic>)
                : null;
        final nm = sm['name'] as String? ?? symbol;
        out.add('  $nm ${spath.isNotEmpty ? '[${rel(spath)}:${(srange?.start.line ?? 0) + 1}]' : ''}');
      }
    } catch (_) {
      out.add('  (none)');
    }
    out.add('overridden by:');
    var overrideCount = 0;
    var overrideCut = false;
    await _subtypeTree(
      item,
      0,
      99,
      out,
      (path) {
        if (overrideCount >= 30) {
          overrideCut = true;
          return true;
        }
        return false;
      },
      includeExternal,
      member: symbol,
      onMemberFound: (desc, path, line) {
        out.add('  $desc [${rel(path)}:$line]');
        overrideCount++;
      },
    );
    if (overrideCut) out.add('  [truncated at 30]');
    final refs =
        await _typeReferences(fileUri(res.path), LspRange(res.pos, res.pos), includeExternal);
    out.add('');
    out.add(refs);
    return out.join('\n');
  }

  Future<void> _subtypeTree(
    Map<String, dynamic> item,
    int level,
    int maxDepth,
    List<String> out,
    bool Function(String path) stopCheck,
    bool includeExternal, {
    String? member,
    void Function(String desc, String path, int line)? onMemberFound,
  }) async {
    if (level > maxDepth) return;
    final subs = await lspCall('typeHierarchy/subtypes', {'item': item}) as List?;
    for (final s in subs ?? []) {
      final sm = s as Map<String, dynamic>;
      final name = sm['name'] as String;
      final su = sm['uri'] as String? ?? '';
      final path = su.isEmpty ? '' : uriPath(su);
      final sel = parseRange((sm['selectionRange'] as Map<String, dynamic>? ??
              {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 0}}));
      if (!isInsideWorkspace(path) && !includeExternal) continue;
      final indent = '  ' * (level + 1);
      if (member == null) {
        out.add('$indent$name ${path.isNotEmpty ? '[${rel(path)}:${sel.start.line + 1}]' : ''}');
      } else {
        // Look for the member in this subtype.
        if (path.isNotEmpty && isInsideWorkspace(path)) {
          try {
            await openPath(path);
            final doc = await lspCall(
              'textDocument/documentSymbol',
              {'textDocument': {'uri': fileUri(path)}},
            ) as List?;
            _findMember(doc ?? [], name, member, (m, line) {
              onMemberFound?.call('$name.$member', path, line + 1);
            });
          } catch (_) {}
        }
      }
      if (stopCheck(path)) return;
      await _subtypeTree(sm, level + 1, maxDepth, out, stopCheck, includeExternal,
          member: member, onMemberFound: onMemberFound);
    }
  }

  void _findMember(List items, String className, String memberName,
      void Function(Map<String, dynamic>, int) onFound) {
    for (final it in items) {
      final m = it as Map<String, dynamic>;
      if (m['name'] == memberName &&
          [6, 7, 8, 9, 25, 26].contains((m['kind'] as num?)?.toInt())) {
        onFound(m, parseRange((m['range'] as Map<String, dynamic>)).start.line);
        return;
      }
      final children = (m['children'] as List?) ?? [];
      _findMember(children, className, memberName, onFound);
    }
  }

  bool _isSealed(Map<String, dynamic> item) {
    try {
      final su = item['uri'] as String? ?? '';
      if (su.isEmpty) return false;
      final path = uriPath(su);
      final sel = parseRange(item['selectionRange'] as Map<String, dynamic>);
      final lines = linesOf(path);
      var i = sel.start.line;
      while (i >= 0) {
        final t = lines[i].trim();
        if (t.startsWith('sealed class') || t.startsWith('base class') ||
            t.startsWith('final class')) {
          return t.startsWith('sealed class');
        }
        if (t.isNotEmpty && !t.startsWith('//')) break;
        i--;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  String _typeNameLine(Map<String, dynamic> item, {required bool includeExternal}) {
    final name = item['name'] as String;
    final u = item['uri'] as String? ?? '';
    final path = u.isEmpty ? '' : uriPath(u);
    final sel = parseRange(
        (item['selectionRange'] as Map<String, dynamic>? ??
            {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 0}}));
    return '$name ${path.isNotEmpty ? '[${rel(path)}:${sel.start.line + 1}]' : '[external]'}';
  }

  Future<String> _typeReferences(String uri, LspRange posRange, bool includeExternal) async {
    final result = await lspCall(
      'textDocument/references',
      {
        'textDocument': {'uri': uri},
        'position': posRange.start.toJson(),
        'context': {'includeDeclaration': true},
      },
    ) as List?;
    final byFile = <String, List<int>>{};
    var skipped = 0;
    for (final r in result ?? []) {
      final ru = (r as Map<String, dynamic>)['uri'] as String;
      final path = uriPath(ru);
      final range = parseRange((r['range'] as Map<String, dynamic>));
      if (!isInsideWorkspace(path) && !includeExternal) {
        skipped++;
        continue;
      }
      byFile.putIfAbsent(rel(path), () => []).add(range.start.line + 1);
    }
    var count = 0;
    final lines = <String>[];
    final entryIndex = <int>[];
    final files = byFile.keys.toList()..sort();
    for (final f in files) {
      final refLines = byFile[f]!..sort();
      lines.add(f);
      entryIndex.add(0);
      for (final l in refLines) {
        lines.add('  $l');
        entryIndex.add(++count);
      }
    }
    var text = budgeted(
        header: 'references: $count',
        lines: lines,
        entryIndex: entryIndex,
        budget: 50);
    if (count == 0) text += '\n(none)';
    if (skipped > 0) {
      text += '\n($skipped external reference(s) hidden; pass includeExternal: true)';
    }
    return text;
  }

  // ------------------------------------------------------------------------
  // diagnose
  // ------------------------------------------------------------------------
  Future<String> diagnose(Map<String, dynamic> p) async {
    final includeInfos = p['includeInfos'] as bool? ?? false;
    final filesArg = (p['files'] as List?)?.cast<String>() ?? [];
    final scope = <String>{};
    for (final f in filesArg) {
      scope.add(resolveFileHint(f));
    }
    if (scope.isEmpty) {
      scope.addAll(state.index.keys);
    }
    for (final path in scope) {
      await openPath(path);
    }
    final cap = filesArg.isEmpty
        ? const Duration(seconds: 180)
        : const Duration(seconds: 60);
    debugLog('diagnose scope=${scope.length} pending=${state.pendingChanges.length} storeKeys=${state.diagnostics.length} analyzing=${state.analyzing}');
    final settled = await awaitSettled(
        cap: cap, hasLiveFile: state.pendingChanges.isNotEmpty && state.pendingChanges.any(state.open.containsKey));
    final rows = <String>[];
    var n = 0;
    for (final path in scope.toList()..sort()) {
      debugLog('  scope $path -> diags=${state.diagnostics[fileUri(path)]?.length ?? 'null'}');
      final diags = state.diagnostics[fileUri(path)] ?? [];
      for (final d in diags) {
        // LSP DiagnosticSeverity: 1=Error 2=Warning 3=Information 4=Hint.
        final sev = (d['severity'] as num?)?.toInt();
        if (sev == null) continue;
        if (sev > 2 && !includeInfos) continue;
        final range = parseRange(d['range'] as Map<String, dynamic>);
        final code = (d['code'] == null) ? '' : '${d['code']}';
        final sevName = sev == 1 ? 'error' : (sev == 2 ? 'warning' : 'info');
        final msg = (d['message'] as String? ?? '').replaceAll('\n', ' ');
        rows.add('  $sevName • ${code.isNotEmpty ? '$code • ' : ''}$msg • ${rel(path)}:${range.start.line + 1}:${range.start.character + 1}');
        n++;
      }
    }
    final out = <String>[];
    if (!settled) {
      out.add('warning: analysis did not settle within cap; results may be partial');
    }
    if (n == 0) {
      out.add('No issues found.');
    } else {
      out.add('$n issue(s):');
      out.addAll(rows);
    }
    return out.join('\n');
  }

  // ------------------------------------------------------------------------
  // fix
  // ------------------------------------------------------------------------
  Future<String> fix(Map<String, dynamic> p) async {
    final line = (p['line'] as num).toInt();
    final path = resolveFileHint(p['file'] as String);
    await openPath(path);
    await awaitSettled(
        cap: const Duration(seconds: 60),
        hasLiveFile: state.pendingChanges.contains(path));
    final diags = state.diagnostics[fileUri(path)] ?? [];
    final l = line - 1; // 0-based
    final onLine = diags.where((d) {
      final r = parseRange(d['range'] as Map<String, dynamic>);
      return r.start.line <= l && r.end.line >= l;
    }).toList();
    LspPos pos;
    if (p['symbol'] != null) {
      final res = await _resolve({'symbol': p['symbol'], 'file': path, 'line': line});
      pos = res.pos;
    } else if (onLine.isNotEmpty) {
      pos = parseRange((onLine.first['range'] as Map<String, dynamic>)).start;
    } else {
      pos = LspPos(line - 1, 0);
    }
    final actions = await lspCall(
      'textDocument/codeAction',
      {
        'textDocument': {'uri': fileUri(path)},
        'range': {
          'start': pos.toJson(),
          'end': pos.toJson()
        },
        'context': {'diagnostics': []},
      },
    ) as List?;
    var list = (actions ?? []).cast<Map<String, dynamic>>();
    // Keep quick fixes for the diagnostics on this line only (the server
    // also returns whole-file source actions).
    const wholeFileCommands = {
      'dart.edit.sortMembers',
      'dart.edit.organizeImports',
      'dart.edit.fixAll',
      'dart.edit.fixAllInWorkspace',
      'dart.edit.fixAllInWorkspace.preview',
    };
    list = list.where((a) {
      final kind = a['kind'] as String? ?? '';
      final cmd = a['command'] as String? ?? '';
      // Command-based quick fixes carry no kind; drop whole-file
      // source/refactor actions.
      return !kind.startsWith('source') &&
          !kind.startsWith('refactor') &&
          !wholeFileCommands.contains(cmd);
    }).toList();
    final pick = (p['pick'] as num?)?.toInt();
    if (pick == null) {
      if (list.isEmpty) {
        return 'no quick fixes for diagnostics on line $line of ${rel(path)}${onLine.isEmpty ? ' (no diagnostics on that line)' : ''}';
      }
      final out = <String>['quick fixes on line $line of ${rel(path)}:'];
      for (var i = 0; i < list.length; i++) {
        final a = list[i];
        final kind = a['kind'] as String? ?? '';
        out.add('  ${i + 1}. ${a['title']} $kind'.trim());
      }
      out.add('call fix again with pick: <n> to get the edit as oldText/newText hunks');
      return out.join('\n');
    }
    if (pick < 1 || pick > list.length) {
      throw StateError('pick out of range: $pick (1..${list.length})');
    }
    final action = list[pick - 1];
    Map<String, dynamic>? edit = action['edit'] as Map<String, dynamic>?;
    if (edit == null && action['data'] != null) {
      try {
        final resolved = await lspCall('codeAction/resolve', action) as Map<String, dynamic>?;
        edit = resolved?['edit'] as Map<String, dynamic>?;
      } catch (_) {}
    }
    if (edit == null) {
      final command = action['command'] as String?;
      if (command != null) {
        final completer = Completer<Map<String, dynamic>>();
        commandApplyEdit = completer;
        dynamic cmdResult;
        try {
          cmdResult = await lspCall('workspace/executeCommand', {
            'command': command,
            'arguments': action['arguments'],
          });
        } catch (e) {
          debugLog('executeCommand failed: $e');
        }
        debugLog(
            'executeCommand result: ${jsonEncode(cmdResult).length > 300 ? jsonEncode(cmdResult).substring(0, 300) : jsonEncode(cmdResult)}');
        try {
          edit = await completer.future.timeout(const Duration(seconds: 10));
        } on TimeoutException {
          commandApplyEdit = null;
          // Some servers return the WorkspaceEdit directly as the
          // executeCommand result.
          if (cmdResult is Map<String, dynamic>) {
            final e2 = cmdResult['edit'] ?? cmdResult;
            if (e2 is Map<String, dynamic> &&
                (e2.containsKey('edits') || e2.containsKey('changes'))) {
              edit = e2;
            }
          }
          if (edit == null) {
            return 'command $command produced no edit within 10s';
          }
        }
        commandApplyEdit = null;
      }
    }
    if (edit == null) {
      return 'action "${action['title']}" has no edit to apply';
    }
    return _workspaceEditToHunks(edit, path);
  }

  String _workspaceEditToHunks(Map<String, dynamic> edit, String primaryPath) {
    final out = <String>[];
    final entries = <(String, List<Map<String, dynamic>>)>[];
    final changes = edit['changes'];
    if (changes is Map<String, dynamic>) {
      for (final e in changes.entries) {
        entries.add((uriPath(e.key), (e.value as List).cast<Map<String, dynamic>>()));
      }
    }
    final editsList = edit['edits'];
    if (editsList is List) {
      for (final e in editsList) {
        final em = e as Map<String, dynamic>;
        entries.add((uriPath(em['resource'] as String), (em['edits'] as List).cast<Map<String, dynamic>>()));
      }
    }
    final docChanges = edit['documentChanges'];
    if (docChanges is List) {
      for (final e in docChanges) {
        final em = e as Map<String, dynamic>;
        final uri = (em['textDocument'] as Map<String, dynamic>)['uri'] as String;
        entries.add((uriPath(uri), (em['edits'] as List).cast<Map<String, dynamic>>()));
      }
    }
    for (final (path, edits) in entries) {
      final text = File(path).readAsStringSync();
      final lines = text.split('\n');
      for (final e in edits) {
        final range = parseRange(e['range'] as Map<String, dynamic>);
        var start = range.start.line;
        var end = range.end.line;
        // LSP end is exclusive: a whole-line edit ends at char 0 of the
        // next line; same-line edits need the line itself.
        var stop = range.end.line == start
            ? start + 1
            : (range.end.character == 0 ? end : end + 1);
        if (stop > lines.length) stop = lines.length;
        var old = lines.sublist(start, stop).join('\n');
        var newTxt = e['newText'] as String? ?? '';
        var guard = 0;
        while (!_uniqueIn(text, old) && guard < 200) {
          if (start - 1 < 0 && end + 1 >= lines.length) break;
          if (start - 1 >= 0) {
            old = '${lines[start - 1]}\n$old';
            newTxt = '${lines[start - 1]}\n$newTxt';
            start--;
          }
          if (!_uniqueIn(text, old) && end + 1 < lines.length) {
            old = '$old\n${lines[end + 1]}';
            newTxt = '$newTxt\n${lines[end + 1]}';
            end++;
          }
          guard++;
        }
        out.add('--- oldText');
        out.addAll(old.split('\n'));
        out.add('+++ newText');
        out.addAll(newTxt.split('\n'));
      }
    }
    if (out.isEmpty) return '(empty edit)';
    return 'apply with the edit tool (never auto-applied):\n${out.join('\n')}';
  }

  bool _uniqueIn(String text, String needle) {
    if (needle.isEmpty) return false;
    var idx = text.indexOf(needle);
    if (idx == -1) return false;
    return text.indexOf(needle, idx + 1) == -1;
  }

  // ------------------------------------------------------------------------
  // shared helpers
  // ------------------------------------------------------------------------
  Future<Resolution> _resolve(Map<String, dynamic> p) {
    return resolver.resolve(
      symbol: p['symbol'] as String,
      fileHint: p['file'] as String?,
      lineHint: (p['line'] as num?)?.toInt(),
    );
  }

}
