import 'events.dart';

/// A tiny synchronous event bus.
///
/// Widgets listen for [ShopEvent] subtypes and services dispatch them.
class EventBus {
  final List<void Function(ShopEvent)> _listeners = [];

  void listen(void Function(ShopEvent) listener) {
    _listeners.add(listener);
  }

  void dispatch(ShopEvent event) {
    for (final listener in List.of(_listeners)) {
      listener(event);
    }
  }

  int get listenerCount => _listeners.length;

  void clear() => _listeners.clear();
}
