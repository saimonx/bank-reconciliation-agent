'use strict';

function parseArguments(argv = process.argv.slice(2)) {
    const result = {
        production: false,
        minimumSupport: 4
    };
    const args = [...argv];

    while (args.length > 0) {
        const argument = args.shift();
        if (argument === '--production') {
            result.production = true;
            continue;
        }
        if (argument === '--minimum-support') {
            result.minimumSupport = Number(args.shift());
            continue;
        }
        if (
            argument === '--apply'
            || argument === '--execute'
            || argument === '--write'
            || argument === '--update'
            || argument === '--delete'
        ) {
            throw new Error('bank_history_evaluator_write_option_forbidden');
        }
        throw new Error(`bank_history_evaluator_unknown_option:${argument}`);
    }

    if (!Number.isInteger(result.minimumSupport) || result.minimumSupport < 1) {
        throw new Error('bank_history_evaluator_invalid_minimum_support');
    }
    return result;
}

function replaceCategoryIdsWithNames(predictionsByCategoryId, categories) {
    const namesById = new Map(
        categories.map(category => [String(category._id), category.name])
    );
    return Object.entries(predictionsByCategoryId)
        .map(([categoryId, count]) => ({
            category: namesById.get(categoryId) || '(categoría desconocida)',
            count
        }))
        .sort((left, right) => right.count - left.count);
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
        evaluateHistoricalCategoryClassifier
    } = require('../src/historyClassifier');

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
                .select('date createdAt concept categoryId')
                .lean(),
            BankAccountTransactionCategory.find({})
                .select('_id name')
                .lean()
        ]);
        const evaluation = evaluateHistoricalCategoryClassifier(
            transactions,
            { minimumSupport: options.minimumSupport }
        );
        const report = {
            readOnly: true,
            environment: options.production ? 'production' : process.env.NODE_ENV,
            generatedAt: new Date().toISOString(),
            configuration: evaluation.configuration,
            totals: evaluation.totals,
            abstentionReasons: evaluation.abstentionReasons,
            predictionsByCategory: replaceCategoryIdsWithNames(
                evaluation.predictionsByCategoryId,
                categories
            )
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
    replaceCategoryIdsWithNames,
    run
};
