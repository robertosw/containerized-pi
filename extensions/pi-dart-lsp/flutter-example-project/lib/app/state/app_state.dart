import '../events.dart';
import '../event_bus.dart';
import '../models/cart_item.dart';
import '../models/order.dart';
import '../models/product.dart';
import '../services/catalog_service.dart';
import '../services/order_service.dart';

class AppState {
  AppState()
      : bus = EventBus(),
        catalogService = CatalogService(),
        orderService = OrderService();

  final EventBus bus;
  final CatalogService catalogService;
  final OrderService orderService;

  final List<CartItem> _cart = [];
  List<Order> _orders = [];

  List<CartItem> get cart => List.unmodifiable(_cart);
  List<Order> get orders => List.unmodifiable(_orders);
  List<Product> get products => catalogService.products;

  int get cartTotalCents => _cart.fold(0, (sum, item) => sum + item.subtotalCents);

  void bootstrap() {
    catalogService.load();
    bus.dispatch(const CartChangedEvent(totalItems: 0));
  }

  void addToCart(Product product) {
    final index = _cart.indexWhere((item) => item.product.id == product.id);
    if (index == -1) {
      _cart.add(CartItem(product: product, quantity: 1));
    } else {
      _cart[index] = _cart[index].copiedWithQuantity(_cart[index].quantity + 1);
    }
    bus.dispatch(CartChangedEvent(totalItems: cartCount));
  }

  void removeFromCart(Product product) {
    _cart.removeWhere((item) => item.product.id == product.id);
    bus.dispatch(CartChangedEvent(totalItems: cartCount));
  }

  Order placeOrder() {
    final order = orderService.place(_cart, cartTotalCents);
    _orders = [order, ..._orders];
    _cart.clear();
    bus.dispatch(OrderPlacedEvent(orderId: order.id));
    bus.dispatch(CartChangedEvent(totalItems: 0));
    return order;
  }

  int get cartCount => _cart.fold(0, (sum, item) => sum + item.quantity);
}
