'use strict';

const { getOpenAIClient } = require('./openaiConfig');
const {
    BankAccount,
    BankAccountOtherPredictedTransaction,
    BankAccountTransaction,
    BankAccountTransactionCategory,
    PaymentReservation,
    ServiceReservation
} = require('./adapters/models');
const {
    CATEGORY_IGNORE,
    CATEGORY_NOT_APPLICABLE,
    buildNewTransactionEligibilityFilter,
    buildOpenAIRequest,
    chunkItems,
    normalizeNewTransactionIds,
    parseOpenAIResponse,
    resolveCategoryAction,
    selectAssociationCandidates,
    validateAssociationSelection,
    validateOpenAIResults
} = require('./reconciliationRules');
const {
    getDeterministicCategoryDecision,
    normalizeRuleText
} = require('./categoryRules');
const {
    buildHistoricalCategoryIndex,
    getHistoricalCategoryDecision
} = require('./historyClassifier');

function applySession(query, session) {
    return session ? query.session(session) : query;
}

function unassociatedArrayFilter() {
    return {
        $or: [
            { transactionIds: { $exists: false } },
            { transactionIds: { $size: 0 } }
        ]
    };
}

async function getAssociatedTransactionIdSet(transactionIds, session = null) {
    if (!transactionIds.length) {
        return new Set();
    }
    const filter = { transactionIds: { $in: transactionIds } };
    const legacyFilter = { transactionId: { $in: transactionIds } };
    const queries = [
        PaymentReservation.distinct('transactionIds', filter),
        ServiceReservation.distinct('transactionIds', filter),
        BankAccountOtherPredictedTransaction.distinct('transactionIds', filter),
        BankAccountOtherPredictedTransaction.distinct('transactionId', legacyFilter)
    ].map(query => applySession(query, session));
    const values = await Promise.all(queries);
    return new Set(values.flat().filter(Boolean).map(value => String(value)));
}

function mapPaymentCandidate(payment) {
    const reference = payment.reservationId
        && payment.reservationId.attachmentSignedContractReference;
    return {
        id: String(payment._id),
        kind: 'payment',
        amount: payment.totalPending,
        date: payment.date,
        reference: reference || null,
        texts: [payment.title, reference].filter(Boolean),
        transactionIds: payment.transactionIds || [],
        legacyTransactionId: null
    };
}

function mapServiceCandidate(service) {
    const evidenceTexts = [
        service.providerBoughtName,
        service.providerFinalName,
        service.providerBoughtReference,
        service.providerFinalReference
    ].filter(Boolean);
    return {
        id: String(service._id),
        kind: 'service',
        amount: service.totalPending,
        date: service.paymentDate || service.dateStart,
        reference: service.providerBoughtReference
            || service.providerFinalReference
            || null,
        texts: [
            service.title,
            ...evidenceTexts
        ].filter(Boolean),
        evidenceTexts,
        transactionIds: service.transactionIds || [],
        legacyTransactionId: null
    };
}

function mapOtherCandidate(prediction) {
    return {
        id: String(prediction._id),
        kind: 'other',
        amount: prediction.totalPending,
        date: prediction.date,
        reference: null,
        texts: [prediction.concept].filter(Boolean),
        transactionIds: prediction.transactionIds || [],
        legacyTransactionId: prediction.transactionId || null
    };
}

async function loadAutomationContext(newTransactionIds) {
    const categoryFilter = {
        categoryType: 'expense',
        subcategories: { $size: 0 }
    };
    if (process.env.BANK_AUTOMATION_EXCLUDED_CATEGORY_ID) {
        categoryFilter._id = {
            $ne: process.env.BANK_AUTOMATION_EXCLUDED_CATEGORY_ID
        };
    }

    const pendingUnassociatedFilter = {
        totalPending: { $type: 'number', $ne: 0 },
        ...unassociatedArrayFilter()
    };
    const [
        transactions,
        finalExpenseCategories,
        verifiedHistory,
        payments,
        services,
        otherPredictions,
        bankAccounts
    ] = await Promise.all([
        BankAccountTransaction.find(
            buildNewTransactionEligibilityFilter(newTransactionIds)
        ).lean(),
        BankAccountTransactionCategory.find(categoryFilter).lean(),
        BankAccountTransaction.find({
            _id: { $nin: newTransactionIds },
            amount: { $lt: 0 },
            categoryId: { $ne: null },
            isVerified: true,
            isIgnored: false,
            concept: { $type: 'string' }
        }).select('concept categoryId').lean(),
        PaymentReservation.find(pendingUnassociatedFilter)
            .populate('reservationId', 'attachmentSignedContractReference')
            .select('_id transactionIds totalPending title date reservationId')
            .lean(),
        ServiceReservation.find(pendingUnassociatedFilter)
            .select([
                '_id',
                'transactionIds',
                'totalPending',
                'title',
                'paymentDate',
                'dateStart',
                'providerBoughtName',
                'providerFinalName',
                'providerBoughtReference',
                'providerFinalReference'
            ].join(' '))
            .lean(),
        BankAccountOtherPredictedTransaction.find({
            ...pendingUnassociatedFilter,
            transactionId: null
        }).select([
            '_id',
            'transactionId',
            'transactionIds',
            'totalPending',
            'date',
            'concept'
        ].join(' ')).lean(),
        BankAccount.find({
            iban: { $type: 'string' }
        }).select('iban').lean()
    ]);

    const associatedTransactionIds = await getAssociatedTransactionIdSet(
        newTransactionIds
    );
    const eligibleTransactions = transactions.filter(transaction => (
        !associatedTransactionIds.has(String(transaction._id))
    ));
    const categoryNames = finalExpenseCategories.map(category => category.name);
    const normalizedCategoryNames = new Set(
        categoryNames.map(normalizeRuleText)
    );
    if (normalizedCategoryNames.size !== categoryNames.length) {
        throw new Error('bank_automation_expense_category_names_ambiguous');
    }

    const categoryNamesById = new Map(
        finalExpenseCategories.map(category => [String(category._id), category.name])
    );
    const historyIndex = buildHistoricalCategoryIndex(verifiedHistory);
    const allCandidates = [
        ...payments.map(mapPaymentCandidate),
        ...services.map(mapServiceCandidate),
        ...otherPredictions.map(mapOtherCandidate)
    ];
    const candidatesByTransaction = new Map();
    const hintsByTransaction = new Map();
    const ownIbans = bankAccounts.map(bankAccount => bankAccount.iban).filter(Boolean);

    for (const transaction of eligibleTransactions) {
        const txId = String(transaction._id);
        candidatesByTransaction.set(
            txId,
            selectAssociationCandidates(transaction, allCandidates)
        );

        const deterministicDecision = getDeterministicCategoryDecision(
            transaction,
            { ownIbans }
        );
        let deterministicCategory = null;
        if (deterministicDecision.matched) {
            deterministicCategory = deterministicDecision.action === 'ignore'
                ? CATEGORY_IGNORE
                : deterministicDecision.categoryName;
        }
        const historicalDecision = getHistoricalCategoryDecision(
            historyIndex,
            transaction.concept
        );
        const historicalCategory = historicalDecision.matched
            ? categoryNamesById.get(historicalDecision.categoryId) || null
            : null;
        hintsByTransaction.set(txId, {
            deterministicCategory,
            historicalCategory,
            historicalSupport: historicalDecision.matched
                ? historicalDecision.support
                : 0
        });
    }

    return {
        requestedCount: newTransactionIds.length,
        skippedExistingState: newTransactionIds.length - eligibleTransactions.length,
        transactions: eligibleTransactions,
        finalExpenseCategories,
        categoryNames,
        candidatesByTransaction,
        hintsByTransaction,
        ownIbans
    };
}

function getCandidateModel(kind) {
    if (kind === 'payment') {
        return PaymentReservation;
    }
    if (kind === 'service') {
        return ServiceReservation;
    }
    if (kind === 'other') {
        return BankAccountOtherPredictedTransaction;
    }
    return null;
}

async function loadFreshCandidate(candidate, session) {
    const Model = getCandidateModel(candidate.kind);
    if (!Model) {
        return null;
    }
    const filter = {
        _id: candidate.id,
        totalPending: candidate.amount,
        ...unassociatedArrayFilter()
    };
    if (candidate.kind === 'other') {
        filter.transactionId = null;
    }
    const document = await applySession(Model.findOne(filter), session);
    if (!document) {
        return null;
    }
    return {
        document,
        candidate: {
            ...candidate,
            amount: document.totalPending,
            transactionIds: document.transactionIds || [],
            legacyTransactionId: candidate.kind === 'other'
                ? document.transactionId || null
                : null
        }
    };
}

function buildCategoryIdByName(categories) {
    return new Map(categories.map(category => [
        normalizeRuleText(category.name),
        category._id
    ]));
}

function buildDocumentVersionFilter(document) {
    if (document.__v === undefined || document.__v === null) {
        return { __v: { $exists: false } };
    }
    return { __v: document.__v };
}

function buildCandidateClaimFilter(item) {
    const filter = {
        _id: item.document._id,
        totalPending: item.document.totalPending,
        totalPaid: item.document.totalPaid === undefined
            ? null
            : item.document.totalPaid,
        ...unassociatedArrayFilter(),
        ...buildDocumentVersionFilter(item.document)
    };
    if (item.candidate.kind === 'other') {
        filter.transactionId = null;
    }
    return filter;
}

function buildCandidateClaimUpdate(item, transactionId) {
    const pendingAmount = Math.round(
        Number(item.document.totalPending) * 100
    ) / 100;
    const paidAmount = Math.round((
        Number(item.document.totalPaid || 0) + pendingAmount
    ) * 100) / 100;
    return {
        $set: {
            totalPending: 0,
            totalPaid: paidAmount
        },
        $inc: { __v: 1 },
        $push: { transactionIds: transactionId }
    };
}

function buildCandidateRollbackFilter(claim) {
    const filter = {
        _id: claim.claimedDocument._id,
        __v: claim.claimedDocument.__v,
        totalPending: 0,
        totalPaid: claim.claimedDocument.totalPaid,
        transactionIds: {
            $size: 1,
            $all: [claim.transactionId]
        }
    };
    if (claim.item.candidate.kind === 'other') {
        filter.transactionId = null;
    }
    return filter;
}

function buildCandidateRollbackUpdate(claim) {
    return {
        $set: {
            totalPending: claim.item.document.totalPending,
            totalPaid: Number(claim.item.document.totalPaid || 0)
        },
        $pull: { transactionIds: claim.transactionId },
        $inc: { __v: 1 }
    };
}

function getModifiedCount(result) {
    if (!result) {
        return 0;
    }
    if (Number.isInteger(result.modifiedCount)) {
        return result.modifiedCount;
    }
    if (Number.isInteger(result.nModified)) {
        return result.nModified;
    }
    return Number(result.n || 0);
}

async function claimCandidate(item, transactionId) {
    const Model = getCandidateModel(item.candidate.kind);
    const claimedDocument = await Model.findOneAndUpdate(
        buildCandidateClaimFilter(item),
        buildCandidateClaimUpdate(item, transactionId),
        { returnDocument: 'after' }
    );
    if (!claimedDocument) {
        return null;
    }
    return {
        item,
        transactionId,
        claimedDocument
    };
}

async function rollbackCandidateClaims(claims) {
    for (const claim of [...claims].reverse()) {
        const Model = getCandidateModel(claim.item.candidate.kind);
        const result = await Model.updateOne(
            buildCandidateRollbackFilter(claim),
            buildCandidateRollbackUpdate(claim)
        );
        if (getModifiedCount(result) !== 1) {
            throw new Error(
                `bank_automation_candidate_rollback_failed:${claim.item.candidate.kind}:${claim.item.candidate.id}`
            );
        }
    }
}

async function getAssociationKeySetForTransaction(transactionId) {
    const [payments, services, others] = await Promise.all([
        PaymentReservation.find({ transactionIds: transactionId })
            .select('_id')
            .lean(),
        ServiceReservation.find({ transactionIds: transactionId })
            .select('_id')
            .lean(),
        BankAccountOtherPredictedTransaction.find({
            $or: [
                { transactionIds: transactionId },
                { transactionId }
            ]
        }).select('_id').lean()
    ]);
    return new Set([
        ...payments.map(document => `payment:${document._id}`),
        ...services.map(document => `service:${document._id}`),
        ...others.map(document => `other:${document._id}`)
    ]);
}

function associationKeySetsEqual(actual, expected) {
    if (actual.size !== expected.size) {
        return false;
    }
    return [...actual].every(key => expected.has(key));
}

function buildTransactionUpdate({
    transaction,
    categoryAction,
    categoryId,
    hasAssociations
}) {
    const set = {};
    if (categoryAction === CATEGORY_IGNORE) {
        set.isIgnored = true;
    } else if (categoryAction !== CATEGORY_NOT_APPLICABLE && categoryId) {
        set.categoryId = categoryId;
    }
    if (hasAssociations) {
        set.amountUnasigned = 0;
    }
    if (Object.keys(set).length === 0) {
        return null;
    }
    return {
        filter: {
            _id: transaction._id,
            categoryId: null,
            isVerified: false,
            isIgnored: false,
            amountUnasigned: transaction.amountUnasigned,
            ...buildDocumentVersionFilter(transaction)
        },
        update: {
            $set: set,
            $inc: { __v: 1 }
        }
    };
}

function buildTransactionRollbackOperation(original, updated) {
    return {
        filter: {
            _id: updated._id,
            __v: updated.__v,
            categoryId: updated.categoryId || null,
            isVerified: false,
            isIgnored: updated.isIgnored,
            amountUnasigned: updated.amountUnasigned
        },
        update: {
            $set: {
                categoryId: original.categoryId || null,
                isIgnored: original.isIgnored,
                amountUnasigned: original.amountUnasigned
            },
            $inc: { __v: 1 }
        }
    };
}

async function rollbackTransactionUpdate(original, updated) {
    const rollback = buildTransactionRollbackOperation(original, updated);
    const result = await BankAccountTransaction.updateOne(
        rollback.filter,
        rollback.update
    );
    if (getModifiedCount(result) !== 1) {
        throw new Error(
            `bank_automation_transaction_rollback_failed:${original._id}`
        );
    }
}

async function applyAnalysisResult({
    transactionSnapshot,
    result,
    allowedCandidates,
    finalExpenseCategories,
    ownIbans
}, persistenceOverrides = {}) {
    const persistence = {
        transactionModel: BankAccountTransaction,
        loadFreshCandidate,
        claimCandidate,
        rollbackCandidateClaims,
        getAssociationKeySetForTransaction,
        rollbackTransactionUpdate,
        ...persistenceOverrides
    };
    const categoryIdByName = buildCategoryIdByName(finalExpenseCategories);
    const transaction = await persistence.transactionModel.findOne({
        _id: transactionSnapshot._id,
        categoryId: null,
        isVerified: false,
        isIgnored: false
    });
    if (!transaction) {
        return 'skipped_existing_state';
    }

    const existingAssociationKeys = await persistence.getAssociationKeySetForTransaction(
        transaction._id
    );
    if (existingAssociationKeys.size > 0) {
        return 'skipped_existing_state';
    }

    const allowedCandidatesById = new Map(
        allowedCandidates.map(candidate => [String(candidate.id), candidate])
    );
    let associationValidation = validateAssociationSelection(
        transaction,
        result.associationIds,
        allowedCandidatesById
    );
    let freshCandidates = [];
    if (associationValidation.valid && associationValidation.candidates.length) {
        const loaded = await Promise.all(
            associationValidation.candidates.map(candidate => (
                persistence.loadFreshCandidate(candidate, null)
            ))
        );
        if (loaded.every(Boolean)) {
            const freshCandidatesById = new Map(loaded.map(item => [
                String(item.candidate.id),
                item.candidate
            ]));
            associationValidation = validateAssociationSelection(
                transaction,
                result.associationIds,
                freshCandidatesById
            );
            if (associationValidation.valid) {
                freshCandidates = loaded;
            }
        }
    }

    const categoryAction = resolveCategoryAction(
        transaction,
        result.category,
        finalExpenseCategories.map(category => category.name),
        { ownIbans }
    );
    if (categoryAction === CATEGORY_IGNORE) {
        freshCandidates = [];
    }
    const categoryId = categoryAction === CATEGORY_NOT_APPLICABLE
        || categoryAction === CATEGORY_IGNORE
        ? null
        : categoryIdByName.get(normalizeRuleText(categoryAction)) || null;
    const transactionOperation = buildTransactionUpdate({
        transaction,
        categoryAction,
        categoryId,
        hasAssociations: freshCandidates.length > 0
    });
    if (!transactionOperation) {
        return 'no_suggestion';
    }

    const claims = [];
    for (const item of freshCandidates) {
        const claim = await persistence.claimCandidate(item, transaction._id);
        if (!claim) {
            await persistence.rollbackCandidateClaims(claims);
            return 'skipped_existing_state';
        }
        claims.push(claim);
    }

    const expectedAssociationKeys = new Set(claims.map(claim => (
        `${claim.item.candidate.kind}:${claim.item.candidate.id}`
    )));
    const associationKeysBeforeUpdate = await persistence.getAssociationKeySetForTransaction(
        transaction._id
    );
    if (!associationKeySetsEqual(
        associationKeysBeforeUpdate,
        expectedAssociationKeys
    )) {
        await persistence.rollbackCandidateClaims(claims);
        return 'skipped_existing_state';
    }

    const updatedTransaction = await persistence.transactionModel.findOneAndUpdate(
        transactionOperation.filter,
        transactionOperation.update,
        { returnDocument: 'after' }
    );
    if (!updatedTransaction) {
        await persistence.rollbackCandidateClaims(claims);
        return 'skipped_existing_state';
    }

    const associationKeysAfterUpdate = await persistence.getAssociationKeySetForTransaction(
        transaction._id
    );
    if (!associationKeySetsEqual(
        associationKeysAfterUpdate,
        expectedAssociationKeys
    )) {
        await persistence.rollbackTransactionUpdate(transaction, updatedTransaction);
        await persistence.rollbackCandidateClaims(claims);
        return 'skipped_existing_state';
    }

    return [
        updatedTransaction.isIgnored ? 'ignored' : null,
        updatedTransaction.categoryId ? 'categorized' : null,
        claims.length ? 'associated' : null
    ].filter(Boolean).join('_');
}

async function analyzeNewBankTransactions(transactionIds) {
    const newTransactionIds = normalizeNewTransactionIds(transactionIds);
    if (newTransactionIds.length === 0) {
        return {
            skipped: true,
            reason: 'new_transaction_ids_required',
            requested: 0,
            eligible: 0,
            analyzed: 0,
            outcomes: {}
        };
    }
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('bank_automation_openai_key_missing');
    }

    const context = await loadAutomationContext(newTransactionIds);
    if (context.transactions.length === 0) {
        return {
            skipped: true,
            reason: 'new_transactions_already_classified_or_associated',
            requested: context.requestedCount,
            eligible: 0,
            analyzed: 0,
            outcomes: {}
        };
    }

    const openai = getOpenAIClient('OPENAI_API_KEY');
    const analyses = [];
    for (const batch of chunkItems(context.transactions)) {
        const batchIds = new Set(batch.map(transaction => String(transaction._id)));
        const candidatesByTransaction = new Map(
            [...context.candidatesByTransaction.entries()]
                .filter(([txId]) => batchIds.has(txId))
        );
        const hintsByTransaction = new Map(
            [...context.hintsByTransaction.entries()]
                .filter(([txId]) => batchIds.has(txId))
        );
        const request = buildOpenAIRequest({
            transactions: batch,
            categoryNames: context.categoryNames,
            candidatesByTransaction,
            hintsByTransaction
        });
        let response;
        let lastError;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                response = await openai.responses.create(request);
                break;
            } catch (error) {
                lastError = error;
            }
        }
        if (!response) {
            throw lastError;
        }
        const parsed = parseOpenAIResponse(response);
        const results = validateOpenAIResults(
            parsed,
            batch,
            context.categoryNames,
            candidatesByTransaction
        );
        analyses.push(...results);
    }

    const transactionsById = new Map(context.transactions.map(transaction => [
        String(transaction._id),
        transaction
    ]));
    const outcomes = {};
    for (const result of analyses) {
        const outcome = await applyAnalysisResult({
            transactionSnapshot: transactionsById.get(result.txId),
            result,
            allowedCandidates: context.candidatesByTransaction.get(result.txId) || [],
            finalExpenseCategories: context.finalExpenseCategories,
            ownIbans: context.ownIbans
        });
        outcomes[outcome] = (outcomes[outcome] || 0) + 1;
    }

    return {
        skipped: false,
        requested: context.requestedCount,
        eligible: context.transactions.length,
        analyzed: analyses.length,
        skippedExistingState: context.skippedExistingState,
        outcomes
    };
}

module.exports = {
    analyzeNewBankTransactions,
    _private: {
        associationKeySetsEqual,
        buildCandidateClaimFilter,
        buildCandidateClaimUpdate,
        buildCandidateRollbackFilter,
        buildCandidateRollbackUpdate,
        buildDocumentVersionFilter,
        buildTransactionRollbackOperation,
        buildTransactionUpdate,
        getModifiedCount,
        applyAnalysisResult
    }
};
