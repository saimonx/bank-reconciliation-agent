'use strict';

const assert = require('assert');
const {
    compileCategoryRuleSet,
    evaluateDeterministicCategoryRules,
    getDeterministicCategoryDecision,
    normalizeRuleText,
    resolveCategoryDecision
} = require('../src/categoryRules');
const {
    DEFAULT_MINIMUM_SUPPORT
} = require('../src/historyClassifier');
const {
    parseArguments
} = require('../scripts/evaluate-category-rules');

function expense(concept, extra = {}) {
    return {
        amount: -100,
        concept,
        ...extra
    };
}

function expectCategory(concept, categoryName) {
    const decision = getDeterministicCategoryDecision(expense(concept));
    assert.strictEqual(decision.matched, true, concept);
    assert.strictEqual(decision.action, 'categorize', concept);
    assert.strictEqual(decision.categoryName, categoryName, concept);
}

function testConfirmedHistoryThreshold() {
    assert.strictEqual(DEFAULT_MINIMUM_SUPPORT, 4);
}

// These tests run against config/categoryRules.example.json.
function testExampleRules() {
    expectCategory('Compra SKYTICKETS S.L.', 'Flights/Hotels');
    expectCategory('Pago Sky Tickets', 'Flights/Hotels');
    expectCategory('Pago Citytours Tours', 'Activities/Transfers');
    expectCategory('Recibo Google Ireland', 'Online advertising');
    expectCategory('TGSS Cotización R.E. Autónomos', 'Social security');
    // "allOf" needs every pattern: TGSS alone is not enough.
    assert.deepStrictEqual(
        getDeterministicCategoryDecision(expense('TGSS Regimen general')),
        { matched: false, reason: 'no_deterministic_rule' }
    );
}

function testRuleOrderDecides() {
    expectCategory('Comisión compra extranjero Citytours', 'Bank fees');
    expectCategory('Gastos transferencia Citytours', 'Bank fees');
    expectCategory(
        'Fx Charges for card 0000000000 Skytickets Inc',
        'Bank fees'
    );
    expectCategory(
        'Transferencia devoluciones actividades Citytours Centro',
        'Customer refunds'
    );
    assert.deepStrictEqual(
        getDeterministicCategoryDecision(expense(
            'Compra Anthropic comisión 3 incluida'
        )),
        { matched: false, reason: 'no_deterministic_rule' }
    );
}

function testRuleSetIsInjectableAndValidated() {
    const ruleSet = compileCategoryRuleSet({
        rules: [{ ruleId: 'acme', category: 'Software', patterns: ['\\bacme\\b'] }]
    });
    assert.deepStrictEqual(
        getDeterministicCategoryDecision(expense('Recibo ACME'), { ruleSet }),
        {
            matched: true,
            action: 'categorize',
            ruleId: 'acme',
            categoryName: 'Software'
        }
    );
    assert.deepStrictEqual(
        getDeterministicCategoryDecision(expense('Skytickets'), { ruleSet }),
        { matched: false, reason: 'no_deterministic_rule' }
    );
    assert.throws(
        () => compileCategoryRuleSet({ rules: [{ ruleId: 'x', patterns: ['a'] }] }),
        /category_required/
    );
    assert.throws(
        () => compileCategoryRuleSet({ rules: [{ ruleId: 'x', category: 'A' }] }),
        /patterns_required/
    );
    assert.throws(
        () => compileCategoryRuleSet({
            rules: [
                { ruleId: 'x', category: 'A', patterns: ['a'] },
                { ruleId: 'x', category: 'B', patterns: ['b'] }
            ]
        }),
        /ids_duplicated/
    );
}

function testGenericGoogleAndPositiveTransactionsDoNotMatch() {
    assert.deepStrictEqual(
        getDeterministicCategoryDecision(expense('Google Workspace')),
        { matched: false, reason: 'no_deterministic_rule' }
    );
    assert.deepStrictEqual(
        getDeterministicCategoryDecision({
            amount: 100,
            concept: 'Citytours'
        }),
        { matched: false, reason: 'not_eligible_expense' }
    );
}

function testIgnoreRulesNeedStrongEvidence() {
    assert.deepStrictEqual(
        getDeterministicCategoryDecision({
            amount: 500,
            concept: 'Transferencia interna',
            counterpartyIban: 'ES12 3456',
        }, {
            ownIbans: ['ES123456']
        }),
        { matched: true, action: 'ignore', ruleId: 'own_account_transfer' }
    );
    assert.deepStrictEqual(
        getDeterministicCategoryDecision({
            amount: 500,
            concept: 'Transferencia interna'
        }, {
            ownIbans: ['ES123456']
        }),
        { matched: false, reason: 'not_eligible_expense' }
    );
    assert.deepStrictEqual(
        getDeterministicCategoryDecision({
            amount: 500,
            concept: 'Ingreso en wallet Skytickets'
        }),
        { matched: false, reason: 'not_eligible_expense' }
    );
    assert.deepStrictEqual(
        getDeterministicCategoryDecision({
            amount: 500,
            concept: 'Recarga de tarjeta'
        }),
        { matched: true, action: 'ignore', ruleId: 'card_reload' }
    );
}

function testCategoryResolutionFailsClosed() {
    const decision = getDeterministicCategoryDecision(expense('Skytickets'));
    const resolved = resolveCategoryDecision(decision, [{
        _id: 'category-id',
        name: 'Flights/Hotels',
        subcategories: []
    }]);
    assert.strictEqual(resolved.categoryId, 'category-id');

    assert.throws(
        () => resolveCategoryDecision(decision, []),
        /target_not_found/
    );
    assert.throws(
        () => resolveCategoryDecision(decision, [
            { _id: 'one', name: 'Flights/Hotels', subcategories: [] },
            { _id: 'two', name: 'Flights/Hotels', subcategories: [] }
        ]),
        /target_ambiguous/
    );
}

function testRuleNormalization() {
    assert.strictEqual(
        normalizeRuleText('  Comisión—COMPRA  '),
        'comision compra'
    );
}

function testEvaluationOnlyReportsAggregatedDisagreements() {
    const report = evaluateDeterministicCategoryRules([
        {
            amount: -100,
            concept: 'Skytickets',
            categoryId: 'software-category'
        }
    ], new Map([
        ['software-category', 'Software']
    ]));

    assert.strictEqual(report.totals.incorrect, 1);
    assert.deepStrictEqual(
        report.byRule.skytickets.incorrectActualCategories,
        { Software: 1 }
    );
    assert.strictEqual(
        Object.prototype.hasOwnProperty.call(
            report.byRule.skytickets,
            'transactions'
        ),
        false
    );
}

function testEvaluatorRejectsWrites() {
    assert.deepStrictEqual(parseArguments(['--production']), {
        production: true
    });
    assert.throws(
        () => parseArguments(['--write']),
        /write_option_forbidden/
    );
}

function run() {
    testConfirmedHistoryThreshold();
    testExampleRules();
    testRuleOrderDecides();
    testRuleSetIsInjectableAndValidated();
    testGenericGoogleAndPositiveTransactionsDoNotMatch();
    testIgnoreRulesNeedStrongEvidence();
    testCategoryResolutionFailsClosed();
    testRuleNormalization();
    testEvaluationOnlyReportsAggregatedDisagreements();
    testEvaluatorRejectsWrites();
    process.stdout.write('Bank transaction deterministic category rule tests passed.\n');
}

run();
