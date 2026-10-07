'use strict';

const assert = require('assert');
const {
    addVerifiedTransactionToHistory,
    buildHistoricalCategoryIndex,
    createHistoryIndex,
    evaluateHistoricalCategoryClassifier,
    getHistoricalCategoryDecision,
    normalizeExactBankConcept
} = require('../src/historyClassifier');
const {
    parseArguments
} = require('../scripts/evaluate-history-classifier');

function transaction(concept, categoryId, date) {
    return { concept, categoryId, date };
}

function testExactNormalizationIsConservative() {
    assert.strictEqual(
        normalizeExactBankConcept('  SKYTÍCKETS   Ref. 123  '),
        'skytickets ref. 123'
    );
    assert.notStrictEqual(
        normalizeExactBankConcept('Proveedor ref. 123'),
        normalizeExactBankConcept('Proveedor ref. 124')
    );
}

function testRequiresFourUnanimousConfirmations() {
    const index = buildHistoricalCategoryIndex([
        transaction('Mismo concepto', 'category-a'),
        transaction('MISMO CONCEPTO', 'category-a'),
        transaction('Mísmo concepto', 'category-a')
    ]);
    assert.deepStrictEqual(
        getHistoricalCategoryDecision(index, 'mismo concepto'),
        {
            matched: false,
            reason: 'insufficient_history',
            support: 3
        }
    );

    addVerifiedTransactionToHistory(
        index,
        transaction('Mismo concepto', 'category-a')
    );
    assert.deepStrictEqual(
        getHistoricalCategoryDecision(index, 'mismo concepto'),
        {
            matched: true,
            reason: 'unanimous_exact_history',
            categoryId: 'category-a',
            support: 4
        }
    );
}

function testConflictingHistoryAlwaysAbstains() {
    const index = buildHistoricalCategoryIndex([
        transaction('Concepto compartido', 'category-a'),
        transaction('Concepto compartido', 'category-a'),
        transaction('Concepto compartido', 'category-a'),
        transaction('Concepto compartido', 'category-b')
    ]);
    assert.deepStrictEqual(
        getHistoricalCategoryDecision(index, 'Concepto compartido'),
        {
            matched: false,
            reason: 'ambiguous_history',
            support: 4,
            categoryCount: 2
        }
    );
}

function testEmptyConceptAbstains() {
    assert.deepStrictEqual(
        getHistoricalCategoryDecision(createHistoryIndex(), '   '),
        {
            matched: false,
            reason: 'empty_concept'
        }
    );
}

function testWalkForwardEvaluationDoesNotLeakFutureConfirmations() {
    const report = evaluateHistoricalCategoryClassifier([
        transaction('Proveedor estable', 'category-a', '2026-01-01'),
        transaction('Proveedor estable', 'category-a', '2026-01-02'),
        transaction('Proveedor estable', 'category-a', '2026-01-03'),
        transaction('Proveedor estable', 'category-a', '2026-01-04'),
        transaction('Proveedor estable', 'category-a', '2026-01-05'),
        transaction('Proveedor estable', 'category-b', '2026-01-06'),
        transaction('Proveedor estable', 'category-a', '2026-01-07')
    ]);

    assert.strictEqual(report.totals.transactions, 7);
    assert.strictEqual(report.totals.predictions, 2);
    assert.strictEqual(report.totals.correct, 1);
    assert.strictEqual(report.totals.incorrect, 1);
    assert.strictEqual(report.totals.abstentions, 5);
    assert.strictEqual(report.totals.coveragePct, 28.57);
    assert.strictEqual(report.totals.precisionPct, 50);
    assert.strictEqual(report.abstentionReasons.ambiguous_history, 1);
}

function testReadOnlyCliRejectsWriteOptions() {
    assert.deepStrictEqual(
        parseArguments(['--production', '--minimum-support', '5']),
        { production: true, minimumSupport: 5 }
    );
    assert.throws(
        () => parseArguments(['--apply']),
        /write_option_forbidden/
    );
    assert.throws(
        () => parseArguments(['--minimum-support', '0']),
        /invalid_minimum_support/
    );
}

function run() {
    testExactNormalizationIsConservative();
    testRequiresFourUnanimousConfirmations();
    testConflictingHistoryAlwaysAbstains();
    testEmptyConceptAbstains();
    testWalkForwardEvaluationDoesNotLeakFutureConfirmations();
    testReadOnlyCliRejectsWriteOptions();
    process.stdout.write('Bank transaction history classifier tests passed.\n');
}

run();
