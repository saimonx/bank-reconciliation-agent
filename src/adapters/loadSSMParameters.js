'use strict';

// Loads production configuration from AWS SSM Parameter Store. Not part of this extract.
module.exports = { loadSSMParameters: async () => { throw new Error('ssm_adapter_not_configured'); } };
