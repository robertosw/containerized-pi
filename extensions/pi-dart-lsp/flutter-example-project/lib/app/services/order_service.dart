import '../models/cart_item.dart';
import '../models/order.dart';

class OrderService {
  int _counter = 0;

  Order place(List<CartItem> items, int totalCents) {
    _counter++;
    return Order(
      id: 'order-${_counter.toString().padLeft(3, '0')}',
      items: List.of(items),
      totalCents: totalCents,
    );
  }
}
