'use strict';

const fs = require('fs');
const path = require('path');

// No category or supplier is hard-coded here. Categories live in the database and
// are loaded on every run; the rules that point to them live in a private JSON file
// (CATEGORY_RULES_PATH). config/categoryRules.example.json shows the format.
const EXAMPLE_RULES_PATH = path.join(
    __dirname,
    '..',
    'config',
    'categoryRules.example.json'
);

function normalizeRuleText(value) {
    if (value === null || value === undefined) {
        return '';
    }

    return String(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeIban(value) {
    return String(value || '')
        .replace(/\s+/g, '')
        .toUpperCase();
}

function buildTransactionSearchText(transaction) {
    return normalizeRuleText([
        transaction && transaction.concept,
        transaction && transaction.counterpartyName
    ].filter(Boolean).join(' '));
}

function matchesAny(text, patterns) {
    return patterns.some(pattern => pattern.test(text));
}

function isOwnAccountTransfer(transaction, ownIbans) {
    const counterpartyIban = normalizeIban(
        transaction && transaction.counterpartyIban
    );
    if (!counterpartyIban) {
        return false;
    }

    const normalizedOwnIbans = new Set(
        (ownIbans || []).map(normalizeIban).filter(Boolean)
    );
    return normalizedOwnIbans.has(counterpartyIban);
}

function createIgnoreDecision(ruleId) {
    return {
        matched: true,
        action: 'ignore',
        ruleId
    };
}

function createCategoryDecision(ruleId, categoryName) {
    return {
        matched: true,
        action: 'categorize',
        ruleId,
        categoryName
    };
}

function compilePatterns(patterns, ruleId) {
    if (!Array.isArray(patterns) || patterns.length === 0) {
        throw new Error(`bank_category_rule_patterns_required:${ruleId}`);
    }
    return patterns.map(pattern => new RegExp(pattern));
}

function compileRule(rule, { requiresCategory }) {
    const ruleId = rule && rule.ruleId;
    if (!ruleId) {
        throw new Error('bank_category_rule_id_required');
    }
    if (requiresCategory && !rule.category) {
        throw new Error(`bank_category_rule_category_required:${ruleId}`);
    }

    // "patterns": any of them matches. "allOf": every one must match.
    const anyOf = rule.patterns ? compilePatterns(rule.patterns, ruleId) : null;
    const allOf = rule.allOf ? compilePatterns(rule.allOf, ruleId) : null;
    if (!anyOf && !allOf) {
        throw new Error(`bank_category_rule_patterns_required:${ruleId}`);
    }

    return {
        ruleId,
        categoryName: rule.category || null,
        matches: text => (
            (!anyOf || matchesAny(text, anyOf))
            && (!allOf || allOf.every(pattern => pattern.test(text)))
        )
    };
}

function compileCategoryRuleSet(definition) {
    const source = definition || {};
    const ignore = (source.ignore || []).map(rule => (
        compileRule(rule, { requiresCategory: false })
    ));
    const rules = (source.rules || []).map(rule => (
        compileRule(rule, { requiresCategory: true })
    ));

    const ruleIds = [...ignore, ...rules].map(rule => rule.ruleId);
    if (new Set(ruleIds).size !== ruleIds.length) {
        throw new Error('bank_category_rule_ids_duplicated');
    }

    return {
        ignore,
        rules,
        aliasGroups: (source.aliasGroups || []).map(group => (
            group.map(normalizeRuleText).filter(Boolean)
        )),
        promptHints: (source.promptHints || []).map(String)
    };
}

let cachedRuleSet = null;
let cachedRuleSetPath = null;

function loadCategoryRuleSet(filePath) {
    const resolvedPath = filePath
        || process.env.CATEGORY_RULES_PATH
        || EXAMPLE_RULES_PATH;
    if (cachedRuleSet && cachedRuleSetPath === resolvedPath) {
        return cachedRuleSet;
    }

    cachedRuleSet = compileCategoryRuleSet(
        JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
    );
    cachedRuleSetPath = resolvedPath;
    return cachedRuleSet;
}

function getDeterministicCategoryDecision(transaction, options = {}) {
    const text = buildTransactionSearchText(transaction);
    const ruleSet = options.ruleSet || loadCategoryRuleSet();

    if (isOwnAccountTransfer(transaction, options.ownIbans)) {
        return createIgnoreDecision('own_account_transfer');
    }
    for (const rule of ruleSet.ignore) {
        if (rule.matches(text)) {
            return createIgnoreDecision(rule.ruleId);
        }
    }

    const amount = Number(transaction && transaction.amount);
    if (!Number.isFinite(amount) || amount >= 0 || !text) {
        return {
            matched: false,
            reason: 'not_eligible_expense'
        };
    }

    for (const rule of ruleSet.rules) {
        if (rule.matches(text)) {
            return createCategoryDecision(rule.ruleId, rule.categoryName);
        }
    }

    return {
        matched: false,
        reason: 'no_deterministic_rule'
    };
}

function normalizeCategoryName(value) {
    return normalizeRuleText(value);
}

function resolveCategoryDecision(decision, categories) {
    if (!decision || !decision.matched || decision.action !== 'categorize') {
        return decision;
    }

    const expectedName = normalizeCategoryName(decision.categoryName);
    const matches = (categories || []).filter(category => {
        const isLeaf = !Array.isArray(category.subcategories)
            || category.subcategories.length === 0;
        return isLeaf && normalizeCategoryName(category.name) === expectedName;
    });

    if (matches.length === 0) {
        throw new Error(
            `bank_category_rule_target_not_found:${decision.categoryName}`
        );
    }
    if (matches.length > 1) {
        throw new Error(
            `bank_category_rule_target_ambiguous:${decision.categoryName}`
        );
    }

    return {
        ...decision,
        categoryId: String(matches[0]._id)
    };
}

function evaluateDeterministicCategoryRules(transactions, categoryNamesById) {
    const report = {
        totals: {
            transactions: (transactions || []).length,
            matches: 0,
            correct: 0,
            incorrect: 0,
            coveragePct: 0,
            precisionPct: 0
        },
        byRule: {}
    };

    for (const transaction of transactions || []) {
        const decision = getDeterministicCategoryDecision(transaction);
        if (!decision.matched || decision.action !== 'categorize') {
            continue;
        }

        const actualCategoryName = categoryNamesById.get(
            String(transaction.categoryId)
        );
        const correct = normalizeCategoryName(actualCategoryName)
            === normalizeCategoryName(decision.categoryName);
        report.totals.matches++;
        if (correct) {
            report.totals.correct++;
        } else {
            report.totals.incorrect++;
        }

        if (!report.byRule[decision.ruleId]) {
            report.byRule[decision.ruleId] = {
                category: decision.categoryName,
                matches: 0,
                correct: 0,
                incorrect: 0,
                incorrectActualCategories: {},
                precisionPct: 0
            };
        }
        const ruleReport = report.byRule[decision.ruleId];
        ruleReport.matches++;
        if (correct) {
            ruleReport.correct++;
        } else {
            ruleReport.incorrect++;
            const categoryName = actualCategoryName || '(category not found)';
            ruleReport.incorrectActualCategories[categoryName] =
                (ruleReport.incorrectActualCategories[categoryName] || 0) + 1;
        }
    }

    report.totals.coveragePct = report.totals.transactions
        ? Math.round(report.totals.matches * 10000 / report.totals.transactions) / 100
        : 0;
    report.totals.precisionPct = report.totals.matches
        ? Math.round(report.totals.correct * 10000 / report.totals.matches) / 100
        : 0;
    for (const ruleReport of Object.values(report.byRule)) {
        ruleReport.precisionPct = ruleReport.matches
            ? Math.round(ruleReport.correct * 10000 / ruleReport.matches) / 100
            : 0;
    }
    return report;
}

module.exports = {
    buildTransactionSearchText,
    compileCategoryRuleSet,
    evaluateDeterministicCategoryRules,
    getDeterministicCategoryDecision,
    isOwnAccountTransfer,
    loadCategoryRuleSet,
    normalizeIban,
    normalizeRuleText,
    resolveCategoryDecision
};
