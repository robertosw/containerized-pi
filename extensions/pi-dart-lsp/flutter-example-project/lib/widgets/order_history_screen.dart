import 'package:flutter/material.dart';

import '../app/state/app_state.dart';
import '../utils/formatters.dart';

class OrderHistoryScreen extends StatelessWidget {
  const OrderHistoryScreen({super.key, required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    final orders = state.orders;
    if (orders.isEmpty) {
      return const Center(child: Text('No orders yet'));
    }
    return ListView.builder(
      itemCount: orders.length,
      itemBuilder: (context, index) {
        final order = orders[index];
        return ListTile(
          title: Text(order.id),
          subtitle: Text('${order.itemCount} items'),
          trailing: Text(formatCents(order.totalCents)),
        );
      },
    );
  }
}
