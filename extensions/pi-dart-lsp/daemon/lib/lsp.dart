import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'util.dart';

class LspError implements Exception {
  LspError(this.code, this.message);
  final int code;
  final String message;

  @override
  String toString() => 'LspError($code): $message';
}

/// Minimal LSP client over stdio (Content-Length framing).
class LspClient {
  LspClient(this._proc, {
    required this.onDiagnostics,
    required this.onAnalyzerStatus,
    required this.onApplyEdit,
    required this.onStderrLine,
    required this.onExit,
  }) {
    _proc.stdout.listen(_onData);
    _proc.stderr
        .transform(const Utf8Decoder(allowMalformed: true))
        .transform(const LineSplitter())
        .listen(onStderrLine, onError: (_) {});
    _proc.exitCode.then((code) {
      for (final c in _pending.values) {
        c.completeError(LspError(-32000, 'language server exited'));
      }
      _pending.clear();
      onExit(code);
    });
  }

  final Process _proc;
  final void Function(String uri, List<Map<String, dynamic>> diags) onDiagnostics;
  final void Function(bool analyzing) onAnalyzerStatus;
  final void Function(Map<String, dynamic> params) onApplyEdit;
  final void Function(String line) onStderrLine;
  final void Function(int exitCode) onExit;

  int _nextId = 1;
  final Map<int, Completer<dynamic>> _pending = {};
  final BytesBuilder _buf = BytesBuilder();

  void _onData(List<int> bytes) {
    _buf.add(bytes);
    while (true) {
      final list = _buf.toBytes();
      final headerEnd = _findHeaderEnd(list);
      if (headerEnd < 0) return;
      final header = String.fromCharCodes(list.sublist(0, headerEnd));
      final lenMatch = RegExp('content-length:\\s*(\\d+)', caseSensitive: false)
          .firstMatch(header);
      if (lenMatch == null) {
        _buf.clear();
        _buf.add(list.sublist(headerEnd + 4));
        continue;
      }
      final len = int.parse(lenMatch.group(1)!);
      final bodyStart = headerEnd + 4;
      if (list.length < bodyStart + len) return;
      final body =
          utf8.decode(list.sublist(bodyStart, bodyStart + len), allowMalformed: true);
      _buf.clear();
      _buf.add(list.sublist(bodyStart + len));
      try {
        _dispatch(jsonDecode(body) as Map<String, dynamic>);
      } catch (e) {
        // ignore malformed message
      }
    }
  }

  static int _findHeaderEnd(List<int> bytes) {
    for (var i = 0; i + 3 < bytes.length; i++) {
      if (bytes[i] == 13 && bytes[i + 1] == 10 && bytes[i + 2] == 13 && bytes[i + 3] == 10) {
        return i;
      }
    }
    return -1;
  }

  void _dispatch(Map<String, dynamic> msg) {
    final id = msg['id'];
    final method = msg['method'];
    if (id != null && method == null) {
      final c = _pending.remove(id as int);
      if (c == null) return;
      if (msg['error'] != null) {
        final err = msg['error'] as Map<String, dynamic>;
        c.completeError(
            LspError((err['code'] as num).toInt(), (err['message'] as String? ?? '?')));
      } else {
        c.complete(msg['result']);
      }
      return;
    }
    if (method == null) return;
    final params = (msg['params'] as Map<String, dynamic>?) ?? {};
    if (id != null) {
      // Server -> client request.
      if (method == 'workspace/configuration') {
        final items = (params['items'] as List?) ?? const [];
        _sendRaw({
          'jsonrpc': '2.0',
          'id': id,
          'result': List.generate(items.length, (_) => <String, dynamic>{}),
        });
      } else if (method == 'workspace/applyEdit') {
        debugLog('applyEdit received: ${jsonEncode(params).substring(0, 200)}');
        onApplyEdit(params);
        _sendRaw({'jsonrpc': '2.0', 'id': id, 'result': {'applied': false}});
      } else {
        debugLog('server request: $method');
        _sendRaw({'jsonrpc': '2.0', 'id': id, 'result': null});
      }
      return;
    }
    // Notification.
    switch (method) {
      case 'textDocument/publishDiagnostics':
        onDiagnostics(params['uri'] as String,
            (params['diagnostics'] as List?)?.cast<Map<String, dynamic>>() ?? []);
      case '\$/analyzerStatus':
        onAnalyzerStatus(params['isAnalyzing'] as bool? ?? false);
      case 'window/logMessage':
        break;
      default:
        break;
    }
  }

  static const String _HDR = 'Content-Length: ';

  Future<void> _sendRaw(Map<String, dynamic> msg) async {
    final body = utf8.encode(jsonEncode(msg));
    final builder = BytesBuilder()
      ..add(utf8.encode('$_HDR${body.length}\r\n\r\n'))
      ..add(body);
    // No flush(): in this SDK IOSink.flush() on a process pipe binds the
    // sink until a future that never completes, which poisons later adds.
    _proc.stdin.add(builder.toBytes());
  }

  Future<dynamic> request(
    String method,
    Map<String, dynamic> params, {
    Duration timeout = const Duration(seconds: 60),
  }) {
    final id = _nextId++;
    final c = Completer<dynamic>();
    _pending[id] = c;
    _sendRaw({'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params});
    return c.future.timeout(timeout,
        onTimeout: () => throw LspError(-32001, 'request timeout: $method'));
  }

  Future<void> notify(String method, Map<String, dynamic> params) {
    return _sendRaw({'jsonrpc': '2.0', 'method': method, 'params': params});
  }
}
