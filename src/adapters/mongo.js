'use strict';

// MongoDB connection of the host application. Not part of this extract.
module.exports = { isConnected: Promise.reject(new Error('mongo_adapter_not_configured')) };
module.exports.isConnected.catch(() => {});
