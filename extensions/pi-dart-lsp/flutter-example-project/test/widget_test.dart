import 'package:flutter_test/flutter_test.dart';
import 'package:shop_app/utils/event_summarizer.dart';
import 'package:shop_app/utils/formatters.dart';
import 'package:shop_app/app/events.dart';

void main() {
  test('formatCents renders dollars and cents', () {
    expect(formatCents(1499), r'$14.99');
  });

  test('summarize covers every event subtype', () {
    expect(
      EventSummarizer.summarize(const CartChangedEvent(totalItems: 3)),
      'cart changed: 3 items',
    );
    expect(
      EventSummarizer.summarize(const OrderPlacedEvent(orderId: 'o1')),
      'order placed: o1',
    );
  });
}
