import 'dart:io';

import 'state.dart';
import 'util.dart';

class Resolution {
  Resolution(this.path, this.pos, this.declLine);
  final String path;
  final LspPos pos;
  final int declLine; // 0-based line of the identifier occurrence used
}

class AmbiguousResolution implements Exception {
  AmbiguousResolution(this.candidates);
  final List<String> candidates; // "path:line" 1-based
}

class SymbolNotFound implements Exception {
  SymbolNotFound(this.message);
  final String message;
  @override
  String toString() => message;
}

class SymbolResolver {
  SymbolResolver(this.state);
  final DaemonState state;

  /// Scans [text] for identifier occurrences of [symbol], skipping comments,
  /// strings and import lines. Returns (line, character, declKeywordHint).
  List<(int line, int char, bool hint)> _occurrences(String text, String symbol) {
    final out = <(int, int, bool)>[];
    final n = symbol.length;
    var i = 0;
    var line = 0;
    var col = 0;
    String stateName = 'code';
    String? strQuote;
    while (i < text.length) {
      final c = text[i];
      final c2 = i + 1 < text.length ? text[i + 1] : '';
      switch (stateName) {
        case 'code':
          if (c == '/' && c2 == '/') {
            stateName = 'lineComment';
            i += 2;
            col += 2;
            continue;
          }
          if (c == '/' && c2 == '*') {
            stateName = 'blockComment';
            i += 2;
            col += 2;
            continue;
          }
          if (c == "'" || c == '"') {
            stateName = 'string';
            strQuote = c == "'" ? "'" : '"';
            i++;
            col++;
            continue;
          }
          if (c == symbol[0] && text.substring(i, i + n) == symbol) {
            final prevOk =
                i == 0 || !_isIdentChar(text[i - 1]);
            final next = i + n < text.length ? text[i + n] : '';
            final nextOk = next.isEmpty || !_isIdentChar(next);
            if (prevOk && nextOk) {
              var hint = false;
              final lineStart = _lineStartOf(text, i);
              final prefix = text.substring(lineStart, i).trimRight();
              final kw = RegExp(r'\b(class|mixin|enum|extension|typedef)\s*$')
                  .firstMatch(prefix);
              if (kw != null) hint = true;
              out.add((line, col, hint));
              i += n;
              col += n;
              continue;
            }
          }
          if (c == '\n') {
            line++;
            col = 0;
          } else {
            col++;
          }
          i++;
        case 'lineComment':
          if (c == '\n') {
            stateName = 'code';
            line++;
            col = 0;
          } else {
            col++;
          }
          i++;
        case 'blockComment':
          if (c == '*' && c2 == '/') {
            stateName = 'code';
            i += 2;
            col += 2;
            continue;
          }
          if (c == '\n') {
            line++;
            col = 0;
          } else {
            col++;
          }
          i++;
        case 'string':
          final q = strQuote!;
          final isTriple =
              i + 2 < text.length && text[i] == q && text[i + 1] == q;
          if (c == q) {
            if (isTriple) {
              stateName = 'code';
              i += 3;
              col += 3;
              continue;
            }
            stateName = 'code';
            i++;
            col++;
            continue;
          }
          if (c == '\n') {
            line++;
            col = 0;
          } else {
            col++;
          }
          i++;
      }
    }
    return out;
  }

  static bool _isIdentChar(String c) {
    final u = c.codeUnitAt(0);
    return (u >= 97 && u <= 122) ||
        (u >= 65 && u <= 90) ||
        (u >= 48 && u <= 57) ||
        u == 95;
  }

  static int _lineStartOf(String text, int i) {
    final nl = text.lastIndexOf('\n', i - 1);
    return nl == -1 ? 0 : nl + 1;
  }

  /// Resolve [symbol] to a position. [fileHint] is repo-relative/absolute/
  /// suffix; [lineHint] is 1-based.
  Future<Resolution> resolve({
    required String symbol,
    String? fileHint,
    int? lineHint,
  }) async {
    if (fileHint != null) {
      final path = _resolveFile(fileHint);
      final text = File(path).readAsStringSync();
      var occ = _occurrences(text, symbol);
      // line is a hint only: prefer the line, fall back to whole file.
      if (lineHint != null && lineHint >= 1) {
        final onLine = occ.where((o) => o.$1 == lineHint - 1).toList();
        if (onLine.isNotEmpty) occ = onLine;
      }
      if (occ.isEmpty) {
        throw SymbolNotFound(
            'symbol "$symbol" not found in ${_rel(path)}');
      }
      final withHint = occ.where((o) => o.$3).toList();
      final candidates = withHint.isNotEmpty ? withHint : occ;
      if (candidates.length == 1) {
        return Resolution(path, LspPos(candidates.first.$1, candidates.first.$2), candidates.first.$1);
      }
      // Disambiguate by declaration target (definition at each candidate).
      final targets = <String>{};
      final grouped = <String, List<(int, int, bool)>>{};
      for (final cand in candidates) {
        String key;
        try {
          final def = await _definitionAt(path, cand.$1, cand.$2);
          key = def;
        } catch (_) {
          key = '${path}:${cand.$1}';
        }
        targets.add(key);
        grouped.putIfAbsent(key, () => []).add(cand);
      }
      if (targets.length == 1) {
        return Resolution(path,
            LspPos(candidates.first.$1, candidates.first.$2), candidates.first.$1);
      }
      final candLines = grouped.values
          .expand((l) => l)
          .map((c) => '${_rel(path)}:${c.$1 + 1}')
          .toList();
      throw AmbiguousResolution(candLines);
    }

    // No file: workspace/symbol exact-name match.
    final wsResult =
        await lsp('workspace/symbol', {'query': symbol}) as List;
    final exact = wsResult
        .where((m) => (m as Map<String, dynamic>)['name'] == symbol)
        .toList();
    if (exact.isEmpty) {
      throw SymbolNotFound('symbol "$symbol" not found in workspace');
    }
    final byFile = <String, Map<String, dynamic>>{};
    for (final m in exact) {
      final uri = m['location']['uri'] as String;
      byFile[uriPath(uri)] = m;
    }
    if (byFile.length > 1) {
      final lines = byFile.entries.map((e) {
        final r = parseRange((e.value['location'] as Map<String, dynamic>)['range']);
        return '${_rel(e.key)}:${r.start.line + 1}';
      }).toList()..sort();
      throw AmbiguousResolution(lines);
    }
    final path = byFile.keys.first;
    final m = byFile[path]!;
    final wsRange = parseRange((m['location'] as Map<String, dynamic>)['range']);
    // workspace/symbol range spans the doc comment; use the documentSymbol
    // entry with that name whose selectionRange lies inside it.
    final docResult = await lsp(
      'textDocument/documentSymbol',
      {'textDocument': {'uri': fileUri(path)}},
    );
    LspPos? pos;
    if (docResult != null) {
      LspPos? fallback;
      _walkSymbols(docResult as List, (name, sel) {
        if (name == symbol && wsRange.containsPos(sel.start)) {
          pos = sel.start;
          return true;
        }
        if (fallback == null && name == symbol) fallback = sel.start;
        return false;
      });
      pos ??= fallback;
    }
    pos ??= wsRange.start;
    final p = pos!;
    return Resolution(path, p, p.line);
  }

  bool _walkSymbols(List items, bool Function(String name, LspRange sel) visit) {
    for (final it in items) {
      final m = it as Map<String, dynamic>;
      final sel = parseRange(m['selectionRange'] as Map<String, dynamic>);
      if (visit(m['name'] as String, sel)) return true;
      final children = (m['children'] as List?) ?? [];
      if (_walkSymbols(children, visit)) return true;
    }
    return false;
  }

  Future<String> _definitionAt(String path, int line, int character) async {
    final result = await lsp(
      'textDocument/definition',
      {'textDocument': {'uri': fileUri(path)}, 'position': LspPos(line, character).toJson()},
    );
    if (result == null) return '${path}:$line';
    final list = (result as List).cast<Map<String, dynamic>>();
    if (list.isEmpty) return '${path}:$line';
    final first = list.first;
    final uri =
        (first.containsKey('targetUri') ? first['targetUri'] : first['uri']) as String;
    final range = parseRange(
        (first.containsKey('targetRange')
                ? first['targetRange']
                : first['range']) as Map<String, dynamic>);
    return '${uriPath(uri)}:${range.start.line}';
  }

  /// Resolves a repo-relative, absolute, or unique-suffix path.
  String resolveFile(String hint) => _resolveFile(hint);

  String _resolveFile(String hint) {
    final abs = (hint.startsWith('/') ? hint : '${state.workspace}/$hint');
    if (File(abs).existsSync()) return _canonical(abs);
    // Unique suffix match.
    final matches = <String>[];
    for (final p in state.index.keys) {
      if (p.endsWith(hint)) matches.add(p);
    }
    if (matches.length == 1) return matches.first;
    if (matches.length > 1) {
      throw SymbolNotFound(
          'path "$hint" is ambiguous: ${matches.map(_rel).join(', ')}');
    }
    throw SymbolNotFound('file "$hint" not found');
  }

  String _canonical(String p) {
    try {
      return File(p).resolveSymbolicLinksSync();
    } catch (_) {
      return p;
    }
  }

  String _rel(String p) {
    if (p.startsWith(state.workspace)) {
      return p.substring(state.workspace.length + 1);
    }
    return p;
  }

  /// Convenience for query code: the lsp request helper lives on Core.
  late Future<dynamic> Function(String, Map<String, dynamic>) lsp;
}
