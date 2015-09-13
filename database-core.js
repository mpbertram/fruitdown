'use strict';

//
// Class that should contain everything necessary to interact
// with IndexedDB as a generic key-value store (based on LocalStorage).
//

/* global indexedDB,IDBKeyRange */

var STORE = 'fruitdown';

// see http://stackoverflow.com/a/15349865/680742
var nextTick = global.setImmediate || process.nextTick;

// IE has race conditions, which is what these two caches work around
// https://gist.github.com/nolanlawson/a841ee23436410f37168
var cachedDBs = {};
var openReqList = {};

function StorageCore(dbName) {
  this._dbName = dbName;
}

function getDatabase(dbName, callback) {
  if (cachedDBs[dbName]) {
    return nextTick(function () {
      callback(null, cachedDBs[dbName]);
    });
  }

  var req = indexedDB.open(dbName, 1);

  openReqList[dbName] = req;

  req.onupgradeneeded = function (e) {
    var db = e.target.result;

    // Apple migration bug (https://bugs.webkit.org/show_bug.cgi?id=136888)
    // This will be null the first time rather than 0, so check for 1
    if (e.oldVersion === 1) {
      return;
    }

    // use an extra index because that way we can use openKeyCursor,
    // which isn't available in IndexedDB 1.0 for stores, only indexes
    db.createObjectStore(STORE, {keyPath : 'id'})
      .createIndex('key', 'key', {unique: true});

  };

  req.onsuccess = function (e) {
    var db = cachedDBs[dbName] = e.target.result;
    callback(null, db);
  };

  req.onerror = function(e) {
    var msg = 'Failed to open indexedDB, are you in private browsing mode?';
    console.error(msg);
    callback(e);
  };
}

function openTransactionSafely(db, mode) {
  try {
    return {
      txn: db.transaction(STORE, mode)
    };
  } catch (err) {
    return {
      error: err
    };
  }
}

StorageCore.prototype.getKeys = function (callback) {
  getDatabase(this._dbName, function (err, db) {
    if (err) {
      return callback(err);
    }
    var txnRes = openTransactionSafely(db, 'readonly');
    if (txnRes.error) {
      return callback(txnRes.error);
    }
    var txn = txnRes.txn;
    var store = txn.objectStore(STORE);

    txn.onerror = callback;

    var keys = [];
    txn.oncomplete = function () {
      console.log('keys', keys);
      callback(null, keys);
    };

    var req = store.index('key').openKeyCursor();

    req.onsuccess = function (e) {
      var cursor = e.target.result;
      if (!cursor) {
        return;
      }
      keys.push(cursor.key);
      cursor.continue();
    };
  });
};

StorageCore.prototype.put = function (key, value, callback) {
  getDatabase(this._dbName, function (err, db) {
    if (err) {
      return callback(err);
    }
    var txnRes = openTransactionSafely(db, 'readwrite');
    if (txnRes.error) {
      return callback(txnRes.error);
    }
    var txn = txnRes.txn;
    var store = txn.objectStore(STORE);

    var valueToStore = typeof value === 'string' ? value : value.toString();
    var doc = {key: key, value: valueToStore, id: Math.random() * 100000};
    var req = store.put(doc);

    req.onerror = function (e) {
      // ConstraintError, need to update, not put
      e.preventDefault(); // avoid transaction abort
      e.stopPropagation(); // avoid transaction onerror

      var range = IDBKeyRange.bound(key, key + '\xff');
      store.index('key').openKeyCursor(range).onsuccess = function (e) {
        var cursor = e.target.result;
        store.put(doc, cursor.primaryKey);
      };
    };

    txn.onerror = callback;
    txn.oncomplete = function () {
      callback();
    };
  });
};

StorageCore.prototype.get = function (key, callback) {
  getDatabase(this._dbName, function (err, db) {
    if (err) {
      return callback(err);
    }
    var txnRes = openTransactionSafely(db, 'readonly');
    if (txnRes.error) {
      return callback(txnRes.error);
    }
    var txn = txnRes.txn;
    var store = txn.objectStore(STORE);

    var gotten;
    var req = store.index('key').get(key);
    req.onsuccess = function (e) {
      if (e.target.result) {
        gotten = e.target.result.value;
      }
    };

    txn.onerror = callback;
    txn.oncomplete = function () {
      callback(null, gotten);
    };
  });
};

StorageCore.prototype.remove = function (key, callback) {
  getDatabase(this._dbName, function (err, db) {
    if (err) {
      return callback(err);
    }
    var txnRes = openTransactionSafely(db, 'readwrite');
    if (txnRes.error) {
      return callback(txnRes.error);
    }
    var txn = txnRes.txn;
    var store = txn.objectStore(STORE);

    var range = IDBKeyRange.bound(key, key + '\xff');
    store.index('key').openKeyCursor(range).onsuccess = function (e) {
      var cursor = e.target.result;
      if (!cursor) {
        return;
      }
      store.delete(cursor.primaryKey);
    };

    txn.onerror = callback;
    txn.oncomplete = function () {
      callback();
    };
  });
};

StorageCore.destroy = function (dbName, callback) {
  nextTick(function () {
    //Close open request for "dbName" database to fix ie delay.
    if (openReqList[dbName] && openReqList[dbName].result) {
      openReqList[dbName].result.close();
      delete cachedDBs[dbName];
    }
    var req = indexedDB.deleteDatabase(dbName);

    req.onsuccess = function () {
      //Remove open request from the list.
      if (openReqList[dbName]) {
        openReqList[dbName] = null;
      }
      callback(null);
    };

    req.onerror = callback;
  });
};

module.exports = StorageCore;