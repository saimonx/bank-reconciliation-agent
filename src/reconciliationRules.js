'use strict';

const {
    getDeterministicCategoryDecision,
    loadCategoryRuleSet,
    normalizeRuleText
} = require('./categoryRules');

const { OPENAI_DEFAULT_MODEL } = require('./openaiConfig');

const BANK_TRANSACTION_AUTOMATION_MODEL = OPENAI_DEFAULT_MODEL;
const BANK_TRANSACTION_AUTOMATION_BATCH_SIZE = 25;
const ASSOCIATION_DATE_TOLERANCE_DAYS = 60;
const CATEGORY_IGNORE = 'IGNORAR';
const CATEGORY_NOT_APPLICABLE = 'N/A';

const GENERIC_ASSOCIATION_TOKENS = new Set([
    'actividad',
    'actividades',
    'banco',
    'card',
    'cliente',
    'comercio',
    'compra',
    'hotel',
    'nomad',
    'pago',
    'payment',
    'reserva',
    'servicio',
    'tarjeta',
    'transfer',
    'transferencia',
    'traslado',
    'viaje'
]);

function normalizeNewTransactionIds(transactionIds) {
    if (!Array.isArray(transactionIds)) {
        return [];
    }

    const normalized = [];
    const seen = new Set();
    for (const value of transactionIds) {
        const id = String(value || '').trim();
        if (!/^[a-f0-9]{24}$/i.test(id)) {
            throw new Error(`bank_automation_invalid_new_transaction_id:${id}`);
        }
        if (!seen.has(id)) {
            normalized.push(id);
            seen.add(id);
        }
    }
    return normalized;
}

function chunkItems(items, size = BANK_TRANSACTION_AUTOMATION_BATCH_SIZE) {
    if (!Number.isInteger(size) || size < 1) {
        throw new Error('bank_automation_invalid_batch_size');
    }
    const chunks = [];
    for (let index = 0; index < (items || []).length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}

function buildNewTransactionEligibilityFilter(transactionIds) {
    const normalizedIds = normalizeNewTransactionIds(transactionIds);
    if (normalizedIds.length === 0) {
        throw new Error('bank_automation_new_transaction_ids_required');
    }
    return {
        _id: { $in: normalizedIds },
        categoryId: null,
        isVerified: false,
        isIgnored: false
    };
}

function moneyToAbsoluteCents(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? Math.abs(Math.round(amount * 100)) : null;
}

function amountsMatch(left, right) {
    const leftCents = moneyToAbsoluteCents(left);
    const rightCents = moneyToAbsoluteCents(right);
    return leftCents !== null && leftCents === rightCents;
}

function parseDate(value) {
    if (!value) {
        return null;
    }
    const timestamp = Date.parse(`${String(value).slice(0, 10)}T00:00:00.000Z`);
    return Number.isNaN(timestamp) ? null : timestamp;
}

function datesWithinTolerance(left, right, toleranceDays = ASSOCIATION_DATE_TOLERANCE_DAYS) {
    const leftTimestamp = parseDate(left);
    const rightTimestamp = parseDate(right);
    if (leftTimestamp === null || rightTimestamp === null) {
        return false;
    }
    const differenceDays = Math.abs(leftTimestamp - rightTimestamp) / 86400000;
    return differenceDays <= toleranceDays;
}

function getMeaningfulTokens(value) {
    return normalizeRuleText(value)
        .split(' ')
        .filter(token => (
            token.length >= 4
            && !GENERIC_ASSOCIATION_TOKENS.has(token)
        ));
}

function hasAliasEvidence(transactionText, candidateText) {
    const normalizedTransaction = normalizeRuleText(transactionText);
    const normalizedCandidate = normalizeRuleText(candidateText);
    return loadCategoryRuleSet().aliasGroups.some(group => (
        group.some(alias => normalizedTransaction.includes(alias))
        && group.some(alias => normalizedCandidate.includes(alias))
    ));
}

function hasMeaningfulTextEvidence(transactionText, candidateTexts) {
    const normalizedTransaction = normalizeRuleText(transactionText);
    if (!normalizedTransaction) {
        return false;
    }

    const transactionTokens = new Set(getMeaningfulTokens(normalizedTransaction));
    for (const value of candidateTexts || []) {
        const normalizedCandidate = normalizeRuleText(value);
        if (!normalizedCandidate) {
            continue;
        }
        if (
            normalizedCandidate.length >= 4
            && normalizedTransaction.includes(normalizedCandidate)
        ) {
            return true;
        }
        if (hasAliasEvidence(normalizedTransaction, normalizedCandidate)) {
            return true;
        }
        if (getMeaningfulTokens(normalizedCandidate).some(token => (
            transactionTokens.has(token)
        ))) {
            return true;
        }
    }
    return false;
}

function hasReferenceEvidence(transaction, candidate) {
    const concept = normalizeRuleText(transaction && transaction.concept);
    const reference = normalizeRuleText(candidate && candidate.reference);
    return Boolean(reference && reference.length >= 4 && concept.includes(reference));
}

function isUnassociatedCandidate(candidate) {
    return Boolean(
        candidate
        && candidate.id
        && (!Array.isArray(candidate.transactionIds) || candidate.transactionIds.length === 0)
        && !candidate.legacyTransactionId
    );
}

function isServiceCandidateEligible(transaction, candidate) {
    const transactionCents = moneyToAbsoluteCents(transaction && transaction.amount);
    const candidateCents = moneyToAbsoluteCents(candidate && candidate.amount);
    return Boolean(
        Number(transaction && transaction.amount) < 0
        && transactionCents
        && candidateCents
        && candidateCents <= transactionCents
        && datesWithinTolerance(transaction.date, candidate.date)
        && hasMeaningfulTextEvidence(
            transaction.concept,
            Array.isArray(candidate.evidenceTexts)
                ? candidate.evidenceTexts
                : candidate.texts
        )
    );
}

function isPaymentCandidateEligible(transaction, candidate) {
    if (Number(transaction && transaction.amount) <= 0) {
        return false;
    }
    if (hasReferenceEvidence(transaction, candidate)) {
        return true;
    }
    return Boolean(
        amountsMatch(transaction.amount, candidate.amount)
        && datesWithinTolerance(transaction.date, candidate.date)
        && hasMeaningfulTextEvidence(transaction.concept, candidate.texts)
    );
}

function selectAssociationCandidates(transaction, candidates) {
    const available = (candidates || []).filter(isUnassociatedCandidate);
    const exactOtherCandidates = available.filter(candidate => (
        candidate.kind === 'other'
        && amountsMatch(transaction && transaction.amount, candidate.amount)
    ));
    const uniqueOtherCandidate = exactOtherCandidates.length === 1
        ? exactOtherCandidates[0]
        : null;

    return available.filter(candidate => {
        if (candidate.kind === 'other') {
            return candidate === uniqueOtherCandidate;
        }
        if (candidate.kind === 'payment') {
            return isPaymentCandidateEligible(transaction, candidate);
        }
        if (candidate.kind === 'service') {
            return isServiceCandidateEligible(transaction, candidate);
        }
        return false;
    });
}

function validateAssociationSelection(transaction, associationIds, candidatesById) {
    if (!Array.isArray(associationIds) || associationIds.length === 0) {
        return {
            valid: true,
            candidates: []
        };
    }

    const uniqueIds = [...new Set(associationIds.map(value => String(value)))];
    if (uniqueIds.length !== associationIds.length) {
        return { valid: false, reason: 'duplicate_association_id' };
    }

    const selected = uniqueIds.map(id => candidatesById.get(id));
    if (selected.some(candidate => !candidate || !isUnassociatedCandidate(candidate))) {
        return { valid: false, reason: 'association_candidate_not_allowed' };
    }

    const kinds = new Set(selected.map(candidate => candidate.kind));
    if (kinds.size !== 1) {
        return { valid: false, reason: 'mixed_association_kinds' };
    }

    const transactionAmount = Number(transaction && transaction.amount);
    const selectedCents = selected.reduce((total, candidate) => (
        total + (moneyToAbsoluteCents(candidate.amount) || 0)
    ), 0);
    const transactionCents = moneyToAbsoluteCents(transactionAmount);
    if (!transactionCents || selectedCents !== transactionCents) {
        return { valid: false, reason: 'association_amount_mismatch' };
    }

    const kind = selected[0].kind;
    if (kind === 'other') {
        if (selected.length !== 1) {
            return { valid: false, reason: 'other_prediction_must_be_unique' };
        }
    } else if (kind === 'payment') {
        if (
            transactionAmount <= 0
            || selected.some(candidate => !isPaymentCandidateEligible(
                transaction,
                candidate
            ))
        ) {
            return { valid: false, reason: 'payment_evidence_missing' };
        }
    } else if (kind === 'service') {
        if (
            transactionAmount >= 0
            || selected.some(candidate => !isServiceCandidateEligible(
                transaction,
                candidate
            ))
        ) {
            return { valid: false, reason: 'service_evidence_missing' };
        }
    } else {
        return { valid: false, reason: 'unknown_association_kind' };
    }

    return {
        valid: true,
        candidates: selected
    };
}

function findCanonicalCategoryName(value, categoryNames) {
    const normalized = normalizeRuleText(value);
    return (categoryNames || []).find(categoryName => (
        normalizeRuleText(categoryName) === normalized
    )) || null;
}

function resolveCategoryAction(transaction, modelCategory, categoryNames, options = {}) {
    const deterministicDecision = getDeterministicCategoryDecision(
        transaction,
        options
    );
    if (
        deterministicDecision.matched
        && deterministicDecision.action === 'ignore'
    ) {
        return CATEGORY_IGNORE;
    }
    if (
        deterministicDecision.matched
        && deterministicDecision.action === 'categorize'
    ) {
        return findCanonicalCategoryName(
            deterministicDecision.categoryName,
            categoryNames
        ) || CATEGORY_NOT_APPLICABLE;
    }

    const normalizedModelCategory = normalizeRuleText(modelCategory);
    if (normalizedModelCategory === normalizeRuleText(CATEGORY_IGNORE)) {
        return CATEGORY_IGNORE;
    }
    if (Number(transaction && transaction.amount) >= 0) {
        return CATEGORY_NOT_APPLICABLE;
    }
    return findCanonicalCategoryName(modelCategory, categoryNames)
        || CATEGORY_NOT_APPLICABLE;
}

function buildResponseFormat(transactionIds, categoryNames) {
    return {
        type: 'json_schema',
        name: 'new_bank_transaction_analysis',
        strict: true,
        schema: {
            type: 'object',
            properties: {
                results: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            txId: {
                                type: 'string',
                                enum: transactionIds
                            },
                            category: {
                                type: 'string',
                                enum: [
                                    ...categoryNames,
                                    CATEGORY_IGNORE,
                                    CATEGORY_NOT_APPLICABLE
                                ]
                            },
                            associationIds: {
                                type: 'array',
                                items: { type: 'string' }
                            }
                        },
                        required: ['txId', 'category', 'associationIds'],
                        additionalProperties: false
                    }
                }
            },
            required: ['results'],
            additionalProperties: false
        }
    };
}

function serializeCandidate(candidate) {
    return {
        id: String(candidate.id),
        kind: candidate.kind,
        amount: Number(candidate.amount),
        date: candidate.date || null,
        description: (candidate.texts || []).filter(Boolean).join(' | '),
        reference: candidate.reference || null
    };
}

function buildOpenAIRequest({
    transactions,
    categoryNames,
    candidatesByTransaction,
    hintsByTransaction
}) {
    const transactionIds = transactions.map(transaction => String(transaction._id));
    if (transactionIds.length === 0) {
        throw new Error('bank_automation_openai_request_requires_transactions');
    }

    const input = {
        transactions: transactions.map(transaction => {
            const txId = String(transaction._id);
            const hints = hintsByTransaction.get(txId) || {};
            return {
                txId,
                date: transaction.date,
                amount: Number(transaction.amount),
                concept: transaction.concept || '',
                deterministicCategory: hints.deterministicCategory || null,
                historicalCategory: hints.historicalCategory || null,
                historicalSupport: hints.historicalSupport || 0,
                candidates: (candidatesByTransaction.get(txId) || [])
                    .map(serializeCandidate)
            };
        })
    };

    return {
        model: BANK_TRANSACTION_AUTOMATION_MODEL,
        reasoning: { effort: 'low' },
        store: false,
        instructions: [
            'Analiza exclusivamente los movimientos bancarios incluidos.',
            'Devuelve exactamente un resultado por txId y no inventes IDs.',
            'Usa únicamente una categoría permitida por el esquema.',
            'Para importes positivos usa N/A salvo que sea claramente IGNORAR.',
            'Si deterministicCategory está informada, debes usarla.',
            'historicalCategory es evidencia fuerte solo cuando el concepto sea idéntico.',
            ...loadCategoryRuleSet().promptHints,
            'Solo asocia IDs listados dentro de candidates de esa misma transacción.',
            'Las asociaciones deben sumar exactamente el importe absoluto del movimiento.',
            'Los candidatos kind=other ya están filtrados por importe único; la fecha no decide.',
            'Si existe cualquier duda sobre una asociación, devuelve associationIds vacío.',
            'No propongas cambios sobre ningún movimiento o candidato fuera de esta entrada.'
        ].join('\n'),
        input: JSON.stringify(input),
        text: {
            format: buildResponseFormat(transactionIds, categoryNames)
        }
    };
}

function parseOpenAIResponse(response) {
    if (!response || (response.status && response.status !== 'completed')) {
        throw new Error('bank_automation_openai_response_not_completed');
    }
    if (!response.output_text) {
        throw new Error('bank_automation_openai_response_empty');
    }

    try {
        return JSON.parse(response.output_text);
    } catch (error) {
        throw new Error('bank_automation_openai_response_invalid_json');
    }
}

function validateOpenAIResults(
    parsed,
    transactions,
    categoryNames,
    candidatesByTransaction
) {
    const expectedIds = transactions.map(transaction => String(transaction._id));
    const expectedIdSet = new Set(expectedIds);
    const allowedCategories = new Set([
        ...categoryNames,
        CATEGORY_IGNORE,
        CATEGORY_NOT_APPLICABLE
    ]);
    if (!parsed || !Array.isArray(parsed.results)) {
        throw new Error('bank_automation_openai_results_missing');
    }
    if (parsed.results.length !== expectedIds.length) {
        throw new Error('bank_automation_openai_results_incomplete');
    }

    const seenIds = new Set();
    for (const result of parsed.results) {
        const txId = String(result && result.txId || '');
        if (!expectedIdSet.has(txId) || seenIds.has(txId)) {
            throw new Error('bank_automation_openai_result_tx_id_invalid');
        }
        if (!allowedCategories.has(result.category)) {
            throw new Error('bank_automation_openai_result_category_invalid');
        }
        if (!Array.isArray(result.associationIds)) {
            throw new Error('bank_automation_openai_result_associations_invalid');
        }
        const candidateIds = new Set(
            (candidatesByTransaction.get(txId) || [])
                .map(candidate => String(candidate.id))
        );
        if (result.associationIds.some(id => !candidateIds.has(String(id)))) {
            throw new Error('bank_automation_openai_result_association_not_allowed');
        }
        seenIds.add(txId);
    }
    return parsed.results;
}

module.exports = {
    ASSOCIATION_DATE_TOLERANCE_DAYS,
    BANK_TRANSACTION_AUTOMATION_BATCH_SIZE,
    BANK_TRANSACTION_AUTOMATION_MODEL,
    CATEGORY_IGNORE,
    CATEGORY_NOT_APPLICABLE,
    amountsMatch,
    buildNewTransactionEligibilityFilter,
    buildOpenAIRequest,
    chunkItems,
    datesWithinTolerance,
    hasMeaningfulTextEvidence,
    normalizeNewTransactionIds,
    parseOpenAIResponse,
    resolveCategoryAction,
    selectAssociationCandidates,
    validateAssociationSelection,
    validateOpenAIResults
};
