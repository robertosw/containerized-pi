import 'cart_item.dart';

class Order {
  const Order({required this.id, required this.items, required this.totalCents});

  final String id;
  final List<CartItem> items;
  final int totalCents;

  int get itemCount => items.fold(0, (sum, item) => sum + item.quantity);
}
