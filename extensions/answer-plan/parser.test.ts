// Tests for parseQuestions (extensions/answer-plan/parser.ts).
// Intent: lock in plan-skill output parsing — `## Questions` section only,
// N. and N) bullets, multi-line bullets, and the bug fix where a blank line
// terminates a bullet so trailing prose does not leak into the last item.
// Run: node --experimental-strip-types --test extensions/answer-plan/parser.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuestions } from "./parser.ts";

test("parses questions with N. and N) bullets", () => {
	const text = `Here is my plan.

## Questions
1. Which datastore?
2) What request volume?`;
	const items = parseQuestions(text);
	assert.deepEqual(
		items.map((i) => [i.id, i.num, i.text]),
		[
			["Q1", 1, "Which datastore?"],
			["Q2", 2, "What request volume?"],
		],
	);
});

test("trailing prose after a blank line does not leak into the last item", () => {
	const text = `## Questions
1. Which auth method?
   (OAuth, SAML, or both?)

Please answer when ready.`;
	const items = parseQuestions(text);
	assert.equal(items.length, 1);
	assert.equal(items[0].id, "Q1");
	assert.equal(items[0].text, "Which auth method?\n   (OAuth, SAML, or both?)");
	assert.ok(!items[0].text.includes("Please answer"));
});

test("multi-line bullets are captured up to next item", () => {
	const text = `## Questions
1. First line
   continued line
2. Second question`;
	const items = parseQuestions(text);
	assert.equal(items.length, 2);
	assert.equal(items[0].text, "First line\n   continued line");
	assert.equal(items[1].text, "Second question");
});

test("a non-Questions heading terminates the section", () => {
	const text = `## Questions
1. Real question

## Notes
1. Not a question`;
	const items = parseQuestions(text);
	assert.deepEqual(items.map((i) => i.id), ["Q1"]);
});

test("ignores numbered lists outside known sections", () => {
	const text = `Some intro.
1. Not captured
2. Also not captured`;
	assert.deepEqual(parseQuestions(text), []);
});

test("heading matching ignores surrounding whitespace and case", () => {
	const text = `##   questions   
1. Q`;
	const items = parseQuestions(text);
	assert.deepEqual(items.map((i) => i.id), ["Q1"]);
});

test("empty input yields no items", () => {
	assert.deepEqual(parseQuestions(""), []);
});

test("ignores an assumptions section", () => {
	const text = `## Questions
1. Which datastore?

## Assumptions
1. PostgreSQL preferred.
2. Single-region deployment.`;
	const items = parseQuestions(text);
	assert.deepEqual(
		items.map((i) => i.id),
		["Q1"],
	);
});

// Multi-turn ID-collision test: each call is stateless — items always
// start from 1, regardless of what a prior turn's response contained.

test("turn 2: items start from 1, not from prior turn's count", () => {
	// Simulates: turn 1 had 6 questions. Turn 2 response has only 4 questions.
	// Parser must return Q1–Q4, not skip to Q7.
	const text = `## Questions
1. What is the target env?
2. Which auth method?
3. What is the SLA?
4. Multi-region?`;
	const items = parseQuestions(text);
	assert.deepEqual(
		items.map((i) => i.id),
		["Q1", "Q2", "Q3", "Q4"],
	);
	assert.equal(items[0].num, 1);
	assert.equal(items[3].num, 4);
});
