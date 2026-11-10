import 'models/product.dart';

sealed class ShopEvent {
  const ShopEvent();
}

final class CartChangedEvent extends ShopEvent {
  const CartChangedEvent({required this.totalItems});

  final int totalItems;
}

final class OrderPlacedEvent extends ShopEvent {
  const OrderPlacedEvent({required this.orderId});

  final String orderId;
}

final class CatalogLoadedEvent extends ShopEvent {
  const CatalogLoadedEvent({required this.products});

  final List<Product> products;
}
