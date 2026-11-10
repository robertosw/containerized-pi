import 'package:flutter/material.dart';

import '../app/event_bus.dart';
import '../app/events.dart';
import '../app/models/cart_item.dart';
import '../app/state/app_state.dart';
import '../utils/formatters.dart';

class CartScreen extends StatefulWidget {
  const CartScreen({super.key, required this.state});

  final AppState state;

  @override
  State<CartScreen> createState() => _CartScreenState();
}

class _CartScreenState extends State<CartScreen> {
  late final EventBus _bus = widget.state.bus;

  @override
  void initState() {
    super.initState();
    _bus.listen(_onEvent);
  }

  @override
  void dispose() {
    _bus.clear();
    super.dispose();
  }

  void _onEvent(ShopEvent event) {
    if (event is OrderPlacedEvent) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Placed ${event.orderId}')));
      }
    }
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final cart = widget.state.cart;
    return ListView(
      children: [
        for (final CartItem item in cart)
          ListTile(
            title: Text(item.product.name),
            subtitle: Text('${item.quantity} x ${formatCents(item.product.priceCents)}'),
            trailing: Text(formatCents(item.subtotalCents)),
          ),
        Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('Total: ${formatCents(widget.state.cartTotalCents)}'),
              FilledButton(
                onPressed: cart.isEmpty ? null : () => widget.state.placeOrder(),
                child: const Text('Place order'),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
