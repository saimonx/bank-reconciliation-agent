'use strict';

function parseArguments(argv = process.argv.slice(2)) {
    const result = { production: false };
    for (const argument of argv) {
        if (argument === '--production') {
            result.production = true;
            continue;
        }
        if (
            argument === '--apply'
            || argument === '--execute'
            || argument === '--write'
            || argument === '--update'
            || argument === '--delete'
        ) {
            throw new Error('bank_category_rules_evaluator_write_option_forbidden');
        }
        throw new Error(`bank_category_rules_evaluator_unknown_option:${argument}`);
    }
    return result;
}

async function run(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    if (options.production) {
        process.env.NODE_ENV = 'production';
    }

    require('dotenv').config({ quiet: true });
    const mongoose = require('mongoose');
    const { loadSSMParameters } = require('../src/adapters/loadSSMParameters');
    const {
        evaluateDeterministicCategoryRules
    } = require('../src/categoryRules');

    try {
        await loadSSMParameters(true);
        const { isConnected } = require('../src/adapters/mongo');
        const {
            BankAccountTransaction,
            BankAccountTransactionCategory
        } = require('../src/adapters/models');
        await isConnected;

        const [transactions, categories] = await Promise.all([
            BankAccountTransaction.find({
                amount: { $lt: 0 },
                isVerified: true,
                isIgnored: false,
                categoryId: { $ne: null },
                concept: { $type: 'string' }
            })
                .select('amount concept categoryId')
                .lean(),
            BankAccountTransactionCategory.find({})
                .select('_id name')
                .lean()
        ]);
        const categoryNamesById = new Map(
            categories.map(category => [String(category._id), category.name])
        );
        const evaluation = evaluateDeterministicCategoryRules(
            transactions,
            categoryNamesById
        );
        const report = {
            readOnly: true,
            environment: options.production ? 'production' : process.env.NODE_ENV,
            generatedAt: new Date().toISOString(),
            ...evaluation
        };
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return report;
    } finally {
        await mongoose.disconnect().catch(() => {});
    }
}

if (require.main === module) {
    run().catch(error => {
        process.stderr.write(`${error && error.message || error}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    parseArguments,
    run
};
