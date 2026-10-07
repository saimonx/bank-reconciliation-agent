'use strict';

const assert = require('assert');
const fs = require('fs');
const {
    BANK_TRANSACTION_AUTOMATION_MODEL,
    CATEGORY_NOT_APPLICABLE,
    buildNewTransactionEligibilityFilter,
    buildOpenAIRequest,
    normalizeNewTransactionIds,
    parseOpenAIResponse,
    resolveCategoryAction,
    selectAssociationCandidates,
    validateAssociationSelection,
    validateOpenAIResults
} = require('../src/reconciliationRules');
const {
    _private: atomicPersistence
} = require('../src/reconciliationService');

const TX_ONE = '64a000000000000000000001';
const TX_TWO = '64a000000000000000000002';
const CANDIDATE_ONE = '65a000000000000000000001';
const CANDIDATE_TWO = '65a000000000000000000002';
const CANDIDATE_THREE = '65a000000000000000000003';

function transaction(overrides = {}) {
    return {
        _id: TX_ONE,
        date: '2026-08-01',
        amount: -150,
        concept: 'Pago Citytours Madrid',
        ...overrides
    };
}

function candidate(overrides = {}) {
    return {
        id: CANDIDATE_ONE,
        kind: 'service',
        amount: -150,
        date: '2026-07-15',
        texts: ['Citytours traslado Madrid'],
        transactionIds: [],
        legacyTransactionId: null,
        ...overrides
    };
}

function testNewIdsAreMandatoryAndStrict() {
    assert.deepStrictEqual(normalizeNewTransactionIds(), []);
    assert.deepStrictEqual(
        normalizeNewTransactionIds([TX_ONE, TX_ONE, TX_TWO]),
        [TX_ONE, TX_TWO]
    );
    assert.throws(
        () => normalizeNewTransactionIds(['old-or-global-query']),
        /invalid_new_transaction_id/
    );
    assert.deepStrictEqual(
        buildNewTransactionEligibilityFilter([TX_ONE]),
        {
            _id: { $in: [TX_ONE] },
            categoryId: null,
            isVerified: false,
            isIgnored: false
        }
    );
    assert.throws(
        () => buildNewTransactionEligibilityFilter([]),
        /new_transaction_ids_required/
    );
}

function testResponsesApiRequestIsCurrentAndPrivate() {
    const tx = transaction();
    const candidatesByTransaction = new Map([[TX_ONE, [candidate()]]]);
    const request = buildOpenAIRequest({
        transactions: [tx],
        categoryNames: ['Flights/Hotels', 'Activities/Transfers'],
        candidatesByTransaction,
        hintsByTransaction: new Map([[TX_ONE, {
            deterministicCategory: 'Activities/Transfers'
        }]])
    });

    assert.strictEqual(request.model, BANK_TRANSACTION_AUTOMATION_MODEL);
    assert.strictEqual(request.model, 'gpt-6.1-sol');
    assert.deepStrictEqual(request.reasoning, { effort: 'low' });
    assert.strictEqual(request.store, false);
    assert.strictEqual(request.text.format.type, 'json_schema');
    assert.strictEqual(request.text.format.strict, true);
    assert.deepStrictEqual(
        request.text.format.schema.properties.results.items.properties.txId.enum,
        [TX_ONE]
    );
    assert.match(request.instructions, /Skytickets is always Flights\/Hotels/);
}

function testOtherPredictionUsesUniqueExactAmountWithoutDate() {
    const tx = transaction({ amount: -80 });
    const unique = candidate({
        kind: 'other',
        amount: 80,
        date: '2024-01-01',
        texts: ['Previsión aproximada']
    });
    assert.deepStrictEqual(
        selectAssociationCandidates(tx, [unique]).map(item => item.id),
        [CANDIDATE_ONE]
    );

    const duplicate = candidate({
        id: CANDIDATE_TWO,
        kind: 'other',
        amount: -80,
        date: null,
        texts: ['Otra previsión']
    });
    assert.deepStrictEqual(
        selectAssociationCandidates(tx, [unique, duplicate]),
        []
    );
}

function testServicesNeedDateTextAndExactSelectedSum() {
    const tx = transaction();
    const first = candidate({ amount: -50 });
    const second = candidate({
        id: CANDIDATE_TWO,
        amount: -100,
        texts: ['Citytours actividad Madrid']
    });
    const unrelated = candidate({
        id: CANDIDATE_THREE,
        amount: -150,
        texts: ['Proveedor sin relación']
    });
    const selected = selectAssociationCandidates(
        tx,
        [first, second, unrelated]
    );
    assert.deepStrictEqual(
        selected.map(item => item.id),
        [CANDIDATE_ONE, CANDIDATE_TWO]
    );

    const candidatesById = new Map(selected.map(item => [item.id, item]));
    assert.strictEqual(
        validateAssociationSelection(
            tx,
            [CANDIDATE_ONE, CANDIDATE_TWO],
            candidatesById
        ).valid,
        true
    );
    assert.deepStrictEqual(
        validateAssociationSelection(
            tx,
            [CANDIDATE_ONE],
            candidatesById
        ),
        { valid: false, reason: 'association_amount_mismatch' }
    );
}

function testAssociatedOrStaleCandidatesAreNeverOffered() {
    const tx = transaction();
    assert.deepStrictEqual(
        selectAssociationCandidates(tx, [candidate({
            transactionIds: [TX_TWO]
        })]),
        []
    );
    assert.deepStrictEqual(
        selectAssociationCandidates(tx, [candidate({
            legacyTransactionId: TX_TWO
        })]),
        []
    );
    assert.deepStrictEqual(
        selectAssociationCandidates(tx, [candidate({
            date: '2026-04-01'
        })]),
        []
    );
    assert.deepStrictEqual(
        selectAssociationCandidates(
            transaction({ concept: 'Pago Madrid' }),
            [candidate({
                texts: ['Hotel Madrid'],
                evidenceTexts: ['Hotelbank']
            })]
        ),
        []
    );
}

function testRuleCategoryCannotBeOverriddenByModel() {
    assert.strictEqual(
        resolveCategoryAction(
            transaction({ concept: 'Pago Skytickets' }),
            'Activities/Transfers',
            ['Flights/Hotels', 'Activities/Transfers']
        ),
        'Flights/Hotels'
    );
    assert.strictEqual(
        resolveCategoryAction(
            transaction({ amount: 150 }),
            'Flights/Hotels',
            ['Flights/Hotels']
        ),
        CATEGORY_NOT_APPLICABLE
    );
    assert.strictEqual(
        resolveCategoryAction(
            transaction({
                amount: 150,
                concept: 'Transferencia interna',
                counterpartyIban: 'ES12 3456'
            }),
            CATEGORY_NOT_APPLICABLE,
            ['Flights/Hotels'],
            { ownIbans: ['ES123456'] }
        ),
        'IGNORAR'
    );
}

function testStructuredResultsMustCoverOnlyTheNewBatch() {
    const transactions = [
        transaction(),
        transaction({ _id: TX_TWO, amount: 200, concept: 'Ingreso cliente' })
    ];
    const candidatesByTransaction = new Map([
        [TX_ONE, [candidate()]],
        [TX_TWO, []]
    ]);
    const parsed = parseOpenAIResponse({
        status: 'completed',
        output_text: JSON.stringify({
            results: [
                {
                    txId: TX_ONE,
                    category: 'Activities/Transfers',
                    associationIds: [CANDIDATE_ONE]
                },
                {
                    txId: TX_TWO,
                    category: CATEGORY_NOT_APPLICABLE,
                    associationIds: []
                }
            ]
        })
    });
    assert.strictEqual(
        validateOpenAIResults(
            parsed,
            transactions,
            ['Activities/Transfers'],
            candidatesByTransaction
        ).length,
        2
    );

    assert.throws(
        () => validateOpenAIResults(
            { results: [parsed.results[0]] },
            transactions,
            ['Activities/Transfers'],
            candidatesByTransaction
        ),
        /results_incomplete/
    );
    assert.throws(
        () => validateOpenAIResults(
            {
                results: [
                    {
                        ...parsed.results[0],
                        associationIds: [CANDIDATE_THREE]
                    },
                    parsed.results[1]
                ]
            },
            transactions,
            ['Activities/Transfers'],
            candidatesByTransaction
        ),
        /association_not_allowed/
    );
}



function testStandaloneAtomicOperationGuardsAndCompensation() {
    const item = {
        candidate: {
            id: CANDIDATE_ONE,
            kind: 'other'
        },
        document: {
            _id: CANDIDATE_ONE,
            __v: 4,
            totalPending: -50,
            totalPaid: -20
        }
    };
    assert.deepStrictEqual(
        atomicPersistence.buildCandidateClaimFilter(item),
        {
            _id: CANDIDATE_ONE,
            totalPending: -50,
            totalPaid: -20,
            $or: [
                { transactionIds: { $exists: false } },
                { transactionIds: { $size: 0 } }
            ],
            __v: 4,
            transactionId: null
        }
    );
    assert.deepStrictEqual(
        atomicPersistence.buildCandidateClaimUpdate(item, TX_ONE),
        {
            $set: { totalPending: 0, totalPaid: -70 },
            $inc: { __v: 1 },
            $push: { transactionIds: TX_ONE }
        }
    );

    const claim = {
        item,
        transactionId: TX_ONE,
        claimedDocument: {
            _id: CANDIDATE_ONE,
            __v: 5,
            totalPaid: -70
        }
    };
    assert.deepStrictEqual(
        atomicPersistence.buildCandidateRollbackFilter(claim),
        {
            _id: CANDIDATE_ONE,
            __v: 5,
            totalPending: 0,
            totalPaid: -70,
            transactionIds: {
                $size: 1,
                $all: [TX_ONE]
            },
            transactionId: null
        }
    );
    assert.deepStrictEqual(
        atomicPersistence.buildCandidateRollbackUpdate(claim),
        {
            $set: { totalPending: -50, totalPaid: -20 },
            $pull: { transactionIds: TX_ONE },
            $inc: { __v: 1 }
        }
    );

    const operation = atomicPersistence.buildTransactionUpdate({
        transaction: {
            _id: TX_ONE,
            __v: 7,
            amountUnasigned: -150
        },
        categoryAction: 'Flights/Hotels',
        categoryId: CANDIDATE_THREE,
        hasAssociations: true
    });
    assert.deepStrictEqual(operation, {
        filter: {
            _id: TX_ONE,
            categoryId: null,
            isVerified: false,
            isIgnored: false,
            amountUnasigned: -150,
            __v: 7
        },
        update: {
            $set: {
                categoryId: CANDIDATE_THREE,
                amountUnasigned: 0
            },
            $inc: { __v: 1 }
        }
    });
    assert.strictEqual(
        atomicPersistence.associationKeySetsEqual(
            new Set(['service:one']),
            new Set(['service:one'])
        ),
        true
    );
    assert.strictEqual(
        atomicPersistence.associationKeySetsEqual(
            new Set(['service:one']),
            new Set(['service:two'])
        ),
        false
    );
}

async function testPartialCandidateClaimIsCompensated() {
    const tx = transaction({
        concept: 'Pago Citytours Madrid',
        amountUnasigned: -150,
        categoryId: null,
        isVerified: false,
        isIgnored: false,
        __v: 2
    });
    const candidates = [
        candidate({ amount: -50 }),
        candidate({ id: CANDIDATE_TWO, amount: -100 })
    ];
    let claimCalls = 0;
    let rolledBackClaims = null;
    let transactionUpdateCalled = false;
    const outcome = await atomicPersistence.applyAnalysisResult({
        transactionSnapshot: tx,
        result: {
            txId: TX_ONE,
            category: CATEGORY_NOT_APPLICABLE,
            associationIds: [CANDIDATE_ONE, CANDIDATE_TWO]
        },
        allowedCandidates: candidates,
        finalExpenseCategories: [],
        ownIbans: []
    }, {
        transactionModel: {
            findOne: async () => tx,
            findOneAndUpdate: async () => {
                transactionUpdateCalled = true;
                return null;
            }
        },
        getAssociationKeySetForTransaction: async () => new Set(),
        loadFreshCandidate: async freshCandidate => ({
            candidate: freshCandidate,
            document: {
                _id: freshCandidate.id,
                __v: 0,
                totalPending: freshCandidate.amount,
                totalPaid: 0
            }
        }),
        claimCandidate: async (freshItem, transactionId) => {
            claimCalls++;
            if (claimCalls === 2) {
                return null;
            }
            return {
                item: freshItem,
                transactionId,
                claimedDocument: {
                    _id: freshItem.candidate.id,
                    __v: 1
                }
            };
        },
        rollbackCandidateClaims: async claims => {
            rolledBackClaims = claims;
        }
    });
    assert.strictEqual(outcome, 'skipped_existing_state');
    assert.strictEqual(claimCalls, 2);
    assert.strictEqual(rolledBackClaims.length, 1);
    assert.strictEqual(transactionUpdateCalled, false);
}

async function testConcurrentAssociationRollsBackTransactionUpdate() {
    const tx = transaction({
        concept: 'Pago proveedor genérico',
        amountUnasigned: -150,
        categoryId: null,
        isVerified: false,
        isIgnored: false,
        __v: 3
    });
    const categoryId = '66a000000000000000000001';
    const updatedTransaction = {
        ...tx,
        categoryId,
        __v: 4
    };
    const associationStates = [
        new Set(),
        new Set(),
        new Set(['service:concurrent'])
    ];
    let transactionRollback = null;
    let claimsRollback = null;
    const outcome = await atomicPersistence.applyAnalysisResult({
        transactionSnapshot: tx,
        result: {
            txId: TX_ONE,
            category: 'Flights/Hotels',
            associationIds: []
        },
        allowedCandidates: [],
        finalExpenseCategories: [{
            _id: categoryId,
            name: 'Flights/Hotels'
        }],
        ownIbans: []
    }, {
        transactionModel: {
            findOne: async () => tx,
            findOneAndUpdate: async () => updatedTransaction
        },
        getAssociationKeySetForTransaction: async () => (
            associationStates.shift()
        ),
        rollbackTransactionUpdate: async (original, updated) => {
            transactionRollback = { original, updated };
        },
        rollbackCandidateClaims: async claims => {
            claimsRollback = claims;
        }
    });
    assert.strictEqual(outcome, 'skipped_existing_state');
    assert.strictEqual(transactionRollback.original, tx);
    assert.strictEqual(transactionRollback.updated, updatedTransaction);
    assert.deepStrictEqual(claimsRollback, []);
}

function testStandaloneServiceNeverStartsMongoTransactions() {
    const serviceSource = fs.readFileSync(
        require('path').join(__dirname, '../src/reconciliationService.js'),
        'utf8'
    );
    assert.doesNotMatch(serviceSource, /withTransaction|startSession/);
}


async function run() {
    testNewIdsAreMandatoryAndStrict();
    testResponsesApiRequestIsCurrentAndPrivate();
    testOtherPredictionUsesUniqueExactAmountWithoutDate();
    testServicesNeedDateTextAndExactSelectedSum();
    testAssociatedOrStaleCandidatesAreNeverOffered();
    testRuleCategoryCannotBeOverriddenByModel();
    testStructuredResultsMustCoverOnlyTheNewBatch();
    testStandaloneAtomicOperationGuardsAndCompensation();
    await testPartialCandidateClaimIsCompensated();
    await testConcurrentAssociationRollsBackTransactionUpdate();
    testStandaloneServiceNeverStartsMongoTransactions();
    process.stdout.write('New bank transaction automation tests passed.\n');
}

run().catch(error => {
    process.stderr.write(`${error && error.stack || error}\n`);
    process.exitCode = 1;
});
