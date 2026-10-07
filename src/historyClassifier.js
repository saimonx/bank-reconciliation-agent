'use strict';

const DEFAULT_MINIMUM_SUPPORT = 4;

function normalizeExactBankConcept(value) {
    if (value === null || value === undefined) {
        return '';
    }

    return String(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeCategoryId(value) {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value);
}

function validateMinimumSupport(value) {
    const minimumSupport = Number(value);
    if (!Number.isInteger(minimumSupport) || minimumSupport < 1) {
        throw new Error('bank_history_classifier_invalid_minimum_support');
    }
    return minimumSupport;
}

function createHistoryIndex() {
    return new Map();
}

function addVerifiedTransactionToHistory(index, transaction) {
    const conceptKey = normalizeExactBankConcept(transaction && transaction.concept);
    const categoryId = normalizeCategoryId(transaction && transaction.categoryId);
    if (!conceptKey || !categoryId) {
        return false;
    }

    let entry = index.get(conceptKey);
    if (!entry) {
        entry = {
            total: 0,
            categories: new Map()
        };
        index.set(conceptKey, entry);
    }

    entry.total++;
    entry.categories.set(categoryId, (entry.categories.get(categoryId) || 0) + 1);
    return true;
}

function getHistoricalCategoryDecision(index, concept, options = {}) {
    const minimumSupport = validateMinimumSupport(
        options.minimumSupport === undefined
            ? DEFAULT_MINIMUM_SUPPORT
            : options.minimumSupport
    );
    const conceptKey = normalizeExactBankConcept(concept);
    if (!conceptKey) {
        return {
            matched: false,
            reason: 'empty_concept'
        };
    }

    const entry = index.get(conceptKey);
    if (!entry || entry.total < minimumSupport) {
        return {
            matched: false,
            reason: 'insufficient_history',
            support: entry ? entry.total : 0
        };
    }

    if (entry.categories.size !== 1) {
        return {
            matched: false,
            reason: 'ambiguous_history',
            support: entry.total,
            categoryCount: entry.categories.size
        };
    }

    const categoryId = entry.categories.keys().next().value;
    return {
        matched: true,
        reason: 'unanimous_exact_history',
        categoryId,
        support: entry.total
    };
}

function buildHistoricalCategoryIndex(transactions) {
    const index = createHistoryIndex();
    for (const transaction of transactions || []) {
        addVerifiedTransactionToHistory(index, transaction);
    }
    return index;
}

function getSortTimestamp(transaction) {
    const date = transaction && transaction.date
        ? Date.parse(`${transaction.date}T00:00:00.000Z`)
        : Number.NaN;
    if (!Number.isNaN(date)) {
        return date;
    }

    const createdAt = transaction && transaction.createdAt
        ? new Date(transaction.createdAt).getTime()
        : Number.NaN;
    return Number.isNaN(createdAt) ? Number.MAX_SAFE_INTEGER : createdAt;
}

function roundPercentage(numerator, denominator) {
    if (!denominator) {
        return 0;
    }
    return Math.round((numerator * 10000) / denominator) / 100;
}

function evaluateHistoricalCategoryClassifier(transactions, options = {}) {
    const minimumSupport = validateMinimumSupport(
        options.minimumSupport === undefined
            ? DEFAULT_MINIMUM_SUPPORT
            : options.minimumSupport
    );
    const orderedTransactions = (transactions || [])
        .map((transaction, inputOrder) => ({ transaction, inputOrder }))
        .sort((left, right) => {
            const timestampDifference = getSortTimestamp(left.transaction)
                - getSortTimestamp(right.transaction);
            return timestampDifference || left.inputOrder - right.inputOrder;
        });
    const historyIndex = createHistoryIndex();
    const report = {
        configuration: {
            minimumSupport,
            requireUnanimousCategory: true,
            evaluationMode: 'walk_forward',
            normalization: 'lowercase_accents_whitespace_only'
        },
        totals: {
            transactions: orderedTransactions.length,
            predictions: 0,
            correct: 0,
            incorrect: 0,
            abstentions: 0,
            coveragePct: 0,
            precisionPct: 0
        },
        abstentionReasons: {},
        predictionsByCategoryId: {}
    };

    for (const item of orderedTransactions) {
        const transaction = item.transaction;
        const decision = getHistoricalCategoryDecision(
            historyIndex,
            transaction && transaction.concept,
            { minimumSupport }
        );
        const actualCategoryId = normalizeCategoryId(
            transaction && transaction.categoryId
        );

        if (decision.matched) {
            report.totals.predictions++;
            report.predictionsByCategoryId[decision.categoryId] =
                (report.predictionsByCategoryId[decision.categoryId] || 0) + 1;
            if (decision.categoryId === actualCategoryId) {
                report.totals.correct++;
            } else {
                report.totals.incorrect++;
            }
        } else {
            report.totals.abstentions++;
            report.abstentionReasons[decision.reason] =
                (report.abstentionReasons[decision.reason] || 0) + 1;
        }

        addVerifiedTransactionToHistory(historyIndex, transaction);
    }

    report.totals.coveragePct = roundPercentage(
        report.totals.predictions,
        report.totals.transactions
    );
    report.totals.precisionPct = roundPercentage(
        report.totals.correct,
        report.totals.predictions
    );
    return report;
}

module.exports = {
    DEFAULT_MINIMUM_SUPPORT,
    addVerifiedTransactionToHistory,
    buildHistoricalCategoryIndex,
    createHistoryIndex,
    evaluateHistoricalCategoryClassifier,
    getHistoricalCategoryDecision,
    normalizeExactBankConcept,
    validateMinimumSupport
};
