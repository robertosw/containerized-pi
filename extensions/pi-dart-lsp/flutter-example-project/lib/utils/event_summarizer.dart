import '../app/events.dart';

/// Describes how a [ShopEvent] should be summarized for logs.
///
/// Exhaustive over the sealed hierarchy, so adding an event subtype
/// breaks the build here until a case is added.
class EventSummarizer {
  const EventSummarizer._();

  static String summarize(ShopEvent event) {
    switch (event) {
      case CartChangedEvent(:final totalItems):
        return 'cart changed: $totalItems items';
      case OrderPlacedEvent(:final orderId):
        return 'order placed: $orderId';
      case CatalogLoadedEvent(:final products):
        return 'catalog loaded: ${products.length} products';
    }
  }
}
