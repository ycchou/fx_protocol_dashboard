
// ==============================================================================
// ==================== CONFIGURATION (請在此處填寫您的設定) ====================
// ==============================================================================

// --- Google Sheet 設定 ---
const SHEET_ID   = ''; // ❗️ <--- 請務必填寫
const SHEET_NAME = '';                     // 您的工作表名稱，預設是 Sheet1

// --- Etherscan API 設定 (V2) ---
const ETHERSCAN_API_KEY      = ''; // ❗️ <--- 建議更換成您自己的 API Key
const ETHERSCAN_API_BASE_URL = 'https://api.etherscan.io/v2/api';
const ETHERSCAN_CHAIN_ID     = 1;

// --- Telegram Bot 設定 ---
const BOT_TOKEN = ''; // ❗️ <--- 請填寫您的 Bot Token
const CHAT_IDS = [
  { chat_id: '' },
  { chat_id: ''}
];

// --- 監控目標設定 ---
const TARGET_ADDRESS = '0x250893ca4ba5d05626c785e8da758026928fcd24'.toLowerCase();

const WBTC_CONFIG = {
  contractAddress: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
  symbol: 'wBTC',
  decimals: 8,
};

const WSTETH_CONFIG = {
  contractAddress: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0',
  symbol: 'wstETH',
  decimals: 18,
};

const VALID_FUNCTIONS = {
  '0xef9e1aa7': { type: '🟢 Open xPosition',  name: 'openOrAddPositionFlashLoanV2' },
  '0xe8e9fc2a': { type: '🔴 Close xPosition', name: 'closeOrRemovePositionFlashLoanV2' },
  '0x99414c10': { type: '🔴 Open sPosition',  name: 'openOrAddShortPositionFlashLoan' },
  '0xad0acfdc': { type: '🟢 Close sPosition', name: 'closeOrRemoveShortPositionFlashLoan' }
};


// ==================================================================
// ==================== 主要執行函數 (Main Functions) ================
// ==================================================================

// ==================================================================
// ============ 智慧型歷史回補模組 (可自動斷點續跑) ==================
// ==================================================================

const BACKFILL_TRIGGER_NAME = 'continueBackfillTrigger';

/**
 * @description 【手動執行】這是您唯一需要手動執行的函數，用來啟動或重置90天的歷史回補任務。
 */
function startBackfill() {
  // 執行前先清理舊的狀態和觸發器，確保一個乾淨的開始
  cleanupBackfillState();
  
  // 取得90天前的起始時間
  const daysToBackfill = 90;
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - (daysToBackfill * 24 * 60 * 60);

  // 將起始時間存入屬性服務
  PropertiesService.getScriptProperties().setProperty('continuationTimestamp', startTime.toString());
  
  console.log(`--- Starting a new 90-day backfill process from ${new Date(startTime * 1000).toISOString()} ---`);
  
  // 立即啟動第一次執行
  continueBackfill();
}


/**
 * @description 【由觸發器自動執行】這是核心處理函數，會從上次中斷的地方繼續執行，直到超時前自動安排下一次執行。
 */
function continueBackfill() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const startTime = new Date().getTime();
  const timeLimit = 5 * 60 * 1000; // 設定為5分鐘，在6分鐘超時前安全停止
  
  // 從屬性服務中讀取下一個要處理的時間點
  let continuationTimestamp = parseInt(scriptProperties.getProperty('continuationTimestamp'));
  
  if (!continuationTimestamp) {
    console.log("No continuation timestamp found. Backfill might be complete or was not started correctly. Please run 'startBackfill'.");
    return;
  }
  
  const periodHours = 6;
  const periodSeconds = periodHours * 60 * 60;
  const now = Math.floor(Date.now() / 1000);

  console.log(`--- Resuming backfill from ${new Date(continuationTimestamp * 1000).toISOString()} ---`);

  // 迴圈處理數據，直到時間快用完或任務完成
  while (new Date().getTime() - startTime < timeLimit) {
    // 如果處理時間已經超過了當前時間，代表任務完成
    if (continuationTimestamp >= now) {
      console.log('--- Historical data backfill process fully completed! ---');
      cleanupBackfillState(); // 清理狀態和觸發器
      return; // 結束執行
    }
    
    const chunkStart = continuationTimestamp;
    const chunkEnd = chunkStart + periodSeconds;
    
    console.log(`Processing chunk: ${new Date(chunkStart * 1000).toISOString()} to ${new Date(chunkEnd * 1000).toISOString()}`);
    
    // 處理 wBTC 和 wstETH
    [WSTETH_CONFIG, WBTC_CONFIG].forEach(function(tokenConfig) {
      processAndStoreDataForPeriod(chunkStart, chunkEnd, periodHours, tokenConfig);
    });
    
    // 更新時間戳，為下一個區塊做準備
    continuationTimestamp = chunkEnd;
  }
  
  // 當迴圈因為時間耗盡而跳出時
  console.log('Execution time limit approaching. Saving state and scheduling next run...');
  
  // 1. 保存下一次要開始的時間點
  scriptProperties.setProperty('continuationTimestamp', continuationTimestamp.toString());
  
  // 2. 建立一個2分鐘後執行的觸發器來呼叫自己
  scheduleNextBackfillRun();
  
  console.log(`Next run scheduled to continue from ${new Date(continuationTimestamp * 1000).toISOString()}`);
}


/**
 * @description 【輔助函數】建立一個一次性的觸發器，在2分鐘後繼續執行任務。
 */
function scheduleNextBackfillRun() {
  // 先刪除可能存在的舊觸發器，避免重複
  const allTriggers = ScriptApp.getProjectTriggers();
  for (const trigger of allTriggers) {
    if (trigger.getHandlerFunction() === 'continueBackfill') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  
  // 建立一個新的觸發器
  ScriptApp.newTrigger('continueBackfill')
    .timeBased()
    .after(2 * 60 * 1000) // 2分鐘後執行
    .create();
}


/**
 * @description 【輔助函數】清理屬性服務和觸發器。在任務開始前和完成後呼叫。
 */
function cleanupBackfillState() {
  // 刪除儲存的狀態
  PropertiesService.getScriptProperties().deleteProperty('continuationTimestamp');
  
  // 刪除所有相關的觸發器
  const allTriggers = ScriptApp.getProjectTriggers();
  for (const trigger of allTriggers) {
    if (trigger.getHandlerFunction() === 'continueBackfill') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  console.log('Cleaned up backfill state properties and triggers.');
}

/**
 * @description 【手動執行/可選】如果回補過程卡住了，可以手動執行此函數來強制清除狀態和觸發器。
 */
function forceResetBackfill() {
    console.log("--- Forcibly resetting backfill state. ---");
    cleanupBackfillState();
}

/**
 * @description 【觸發器執行】此函數應由每6小時的觸發器呼叫，抓取最新數據並儲存。
 */
function runAndStore6HourReport() {
  const periodHours = 6;
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - (periodHours * 60 * 60);

  console.log(`--- Starting 6-Hour Report for period ending at ${new Date().toISOString()} ---`);

  [WSTETH_CONFIG, WBTC_CONFIG].forEach(function(tokenConfig) {
    processAndStoreDataForPeriod(startTime, now, periodHours, tokenConfig);
  });
  
  console.log('--- 6-Hour Report Generation and Storage Completed ---');
}


/**
 * @description 【手動執行/原有功能】執行所有代幣的報告，將其合併為一則訊息並發送到 Telegram。
 */
function runAllReports() {
    console.log('--- Start Combined Report Generation for Telegram ---');
    var wstethMessage = runReport(WSTETH_CONFIG);
    var wbtcMessage = runReport(WBTC_CONFIG);

    if (wstethMessage && wbtcMessage) {
        var separator = "\n\n================================\n\n";
        var combinedMessage = wstethMessage + separator + wbtcMessage;
        sendToTelegram(combinedMessage);
        console.log('Combined report successfully sent to Telegram.');
    } else {
        console.error('One or both reports failed to generate. Skipping combined Telegram send.');
    }
    console.log('--- Combined Report Generation Completed ---');
}


// ==================================================================
// ==================== 核心數據處理流程 (Core Process) =============
// ==================================================================

/**
 * @description 處理指定時間區間和代幣的數據，並儲存到Sheet。
 * @param {number} startTime - 開始時間的 Unix timestamp。
 * @param {number} endTime - 結束時間的 Unix timestamp。
 * @param {number} periodHours - 數據涵蓋的小時數。
 * @param {Object} tokenConfig - 代幣設定檔。
 */
function processAndStoreDataForPeriod(startTime, endTime, periodHours, tokenConfig) {
  console.log(`Processing for token: ${tokenConfig.symbol}`);
  
  // 1. 取得時間區間內的交易
  var transactions = getPastTokenTransactions(startTime, endTime, tokenConfig);
  if (!transactions || transactions.length === 0) {
    console.log(`No ${tokenConfig.symbol} transactions found in this period.`);
    return;
  }
  console.log(`Fetched ${transactions.length} transaction records for ${tokenConfig.symbol}`);

  // 2. 取得交易詳情
  var txDetailsMap = getTransactionDetailsSequential(transactions);
  if (Object.keys(txDetailsMap).length === 0) {
    console.log(`Unable to fetch transaction details for ${tokenConfig.symbol}`);
    return;
  }

  // 3. 計算統計數據
  var stats = calculateFunctionStats(transactions, txDetailsMap, tokenConfig);
  console.log(`${tokenConfig.symbol} stats calculated: ${JSON.stringify(stats)}`);

  // 4. 儲存到 Google Sheet
  saveDataToSheet(stats, tokenConfig, periodHours, new Date(endTime * 1000));
}


// ==================================================================
// ======================= 核心邏輯 (Core Logic) ====================
// ==================================================================

/**
 * @description [Etherscan V2] Fetches token transactions for the target address within a time range.
 */
function getPastTokenTransactions(startTimestamp, endTimestamp, tokenConfig) {
  var allTransactions = [];
  var page = 1;
  var hasMorePages = true;

  while (hasMorePages) {
    try {
      var apiUrl = `${ETHERSCAN_API_BASE_URL}?chainid=${ETHERSCAN_CHAIN_ID}&module=account&action=tokentx&address=${TARGET_ADDRESS}&contractaddress=${tokenConfig.contractAddress}&page=${page}&offset=1000&sort=desc&apikey=${ETHERSCAN_API_KEY}`;
      var resp = UrlFetchApp.fetch(apiUrl, { muteHttpExceptions: true });
      var data = JSON.parse(resp.getContentText());

      if (data.status === '1' && data.result && data.result.length > 0) {
        var isOutOfTimeWindow = false;
        for (var i = 0; i < data.result.length; i++) {
          var tx = data.result[i];
          var txTimestamp = parseInt(tx.timeStamp);
          if (txTimestamp >= startTimestamp && txTimestamp <= endTimestamp) {
            allTransactions.push(tx);
          }
          if (txTimestamp < startTimestamp) {
            isOutOfTimeWindow = true;
            break;
          }
        }
        if (isOutOfTimeWindow || data.result.length < 1000) {
          hasMorePages = false;
        } else {
          page++;
        }
      } else {
        hasMorePages = false;
        if (data.message && data.message !== "No transactions found") console.error('Etherscan API Error:', data.message);
      }
    } catch (e) {
      console.error('Error fetching page ' + page + ' of token transactions:', e);
      hasMorePages = false;
    }
    if (hasMorePages) Utilities.sleep(200); 
  }
  return allTransactions;
}

/**
 * @description [Etherscan V2] Sequentially fetches full transaction details (including input data).
 */
function getTransactionDetailsSequential(transactions) {
  var txDetailsMap = {};
  var seen = {};
  transactions.forEach(function(tx) {
    if (seen[tx.hash]) return;
    seen[tx.hash] = true;
    var url = `${ETHERSCAN_API_BASE_URL}?chainid=${ETHERSCAN_CHAIN_ID}&module=proxy&action=eth_getTransactionByHash&txhash=${tx.hash}&apikey=${ETHERSCAN_API_KEY}`;
    try {
      var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      var json = JSON.parse(resp.getContentText());
      if (json.result && json.result.hash) {
        txDetailsMap[json.result.hash] = json.result;
      }
    } catch (e) {
      console.error('Error fetching transaction details for ' + tx.hash + ':', e);
    }
    Utilities.sleep(200); 
  });
  return txDetailsMap;
}


/**
 * @description Calculates volume for specific function calls within a given transaction list.
 */
function calculateFunctionStats(transactions, txDetailsMap, tokenConfig) {
  var stats = {};
  Object.keys(VALID_FUNCTIONS).forEach(function(funcId) {
    stats[funcId] = { 'period': 0 };
  });
  transactions.forEach(function(tx) {
    var txDetail = txDetailsMap[tx.hash];
    if (!txDetail || !txDetail.input) return;
    var funcId = txDetail.input.substring(0, 10).toLowerCase();
    if (!VALID_FUNCTIONS[funcId]) return;
    var amount = parseFloat(tx.value) / Math.pow(10, tokenConfig.decimals); 
    stats[funcId]['period'] += amount;
  });
  return stats;
}

// ==================================================================
// ==================== Google Sheet 儲存函數 ======================
// ==================================================================

/**
 * @description 將計算後的統計數據儲存到 Google Sheet。
 */
function saveDataToSheet(stats, tokenConfig, periodHours, timestamp) {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    Object.keys(VALID_FUNCTIONS).forEach(function(funcId) {
      const functionInfo = VALID_FUNCTIONS[funcId];
      const volume = stats[funcId]['period'];
      // 只有在交易量大於 0 時才記錄，避免 sheet 充滿無用數據
      if (volume > 0) {
        const newRow = [
          timestamp,
          tokenConfig.symbol,
          functionInfo.type,
          functionInfo.name,
          volume,
          periodHours
        ];
        sheet.appendRow(newRow);
      }
    });
    console.log(`Data for ${tokenConfig.symbol} saved to Google Sheet.`);
  } catch (e) {
    console.error(`Failed to save data to Google Sheet for ${tokenConfig.symbol}. Error: ${e}`);
    sendToTelegram(`🚨 Google Sheet Bot Alert 🚨\n\nFailed to write data for ${tokenConfig.symbol}.\nError: ${e}`);
  }
}

// ==================================================================
// ==================== Web App API 接口 ==========================
// ==================================================================

/**
 * @description 當 Web App 收到 GET 請求時執行此函數。
 */
function doGet(e) {
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    const data = sheet.getDataRange().getValues();
    const headers = data.shift();
    const jsonData = data.map(function(row) {
      let obj = {};
      headers.forEach(function(header, index) {
        obj[header] = row[index];
      });
      return obj;
    });
    return ContentService.createTextOutput(JSON.stringify({ status: 'success', data: jsonData })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.message })).setMimeType(ContentService.MimeType.JSON);
  }
}


// =======================================================================================
// === 以下為原有 Telegram 報告功能，為保持完整性而保留，無需修改 ==========================
// =======================================================================================

function runReport(tokenConfig) {
  try {
    console.log('--- Start generating ' + tokenConfig.symbol + ' Transaction Report ---');
    //【注意】此處 getPastTokenTransactions 已被修改，這裡我們模擬舊的行為，抓取7天數據
    const sevenDaysAgoTimestamp = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60);
    const nowTimestamp = Math.floor(Date.now() / 1000);
    var transactions = getPastTokenTransactions(sevenDaysAgoTimestamp, nowTimestamp, tokenConfig);

    if (!transactions || transactions.length === 0) {
      return "📊 *" + tokenConfig.symbol + " Volume Report*\n\nNo transactions found in the past 7 days.";
    }
    var txDetailsMap = getTransactionDetailsSequential(transactions);
    if (Object.keys(txDetailsMap).length === 0) {
      return "📊 *" + tokenConfig.symbol + " Volume Report*\n\nCould not fetch transaction details.";
    }
    
    //【注意】此處需要一個獨立的計算函數，因為 calculateFunctionStats 已被修改
    var stats = calculateReportStats(transactions, txDetailsMap, tokenConfig);
    
    var message = buildReportMessage(stats, tokenConfig);
    return message;
  } catch (e) {
    console.error('runReport encountered a critical error for ' + tokenConfig.symbol + ':', e);
    sendToTelegram(tokenConfig.symbol + ' Report Bot failed to execute: ' + e.toString());
    return null;
  }
}

function calculateReportStats(transactions, txDetailsMap, tokenConfig) {
  var stats = {};
  Object.keys(VALID_FUNCTIONS).forEach(function(funcId) {
    stats[funcId] = { '24hr': 0, '7day': 0 };
  });

  var now = Math.floor(Date.now() / 1000);
  var twentyFourHoursAgo = now - (24 * 60 * 60);
  var sevenDaysAgo = now - (7 * 24 * 60 * 60);

  transactions.forEach(function(tx) {
    var txDetail = txDetailsMap[tx.hash];
    if (!txDetail || !txDetail.input) return;

    var funcId = txDetail.input.substring(0, 10).toLowerCase();
    if (!VALID_FUNCTIONS[funcId]) return;

    var ts = parseInt(tx.timeStamp);
    var amount = parseFloat(tx.value) / Math.pow(10, tokenConfig.decimals); 

    if (ts >= sevenDaysAgo) {
      stats[funcId]['7day'] += amount;
      if (ts >= twentyFourHoursAgo) {
        stats[funcId]['24hr'] += amount;
      }
    }
  });
  return stats;
}

function buildReportMessage(stats, tokenConfig) {
  var msg = "📊 *" + tokenConfig.symbol + " Volume Report*\n\n"; 
  var longIds = ['0xef9e1aa7', '0xe8e9fc2a'];
  var shortIds = ['0x99414c10', '0xad0acfdc'];

  msg += "*📈 24-Hour Volume*\n";
  var total24 = 0;
  longIds.forEach(id => { var v = stats[id]['24hr']; total24 += v; msg += `  ${VALID_FUNCTIONS[id].type}: ${v.toFixed(2)} ${tokenConfig.symbol}\n`; });
  msg += "  ---\n";
  shortIds.forEach(id => { var v = stats[id]['24hr']; total24 += v; msg += `  ${VALID_FUNCTIONS[id].type}: ${v.toFixed(2)} ${tokenConfig.symbol}\n`; });
  msg += `\n*Total Volume*: ${total24.toFixed(2)} ${tokenConfig.symbol}\n\n`;

  msg += "*📅 7-Day Volume*\n";
  var total7 = 0;
  longIds.forEach(id => { var v = stats[id]['7day']; total7 += v; msg += `  ${VALID_FUNCTIONS[id].type}: ${v.toFixed(2)} ${tokenConfig.symbol}\n`; });
  msg += "  ---\n";
  shortIds.forEach(id => { var v = stats[id]['7day']; total7 += v; msg += `  ${VALID_FUNCTIONS[id].type}: ${v.toFixed(2)} ${tokenConfig.symbol}\n`; });
  msg += `\n*Total Volume*: ${total7.toFixed(2)} ${tokenConfig.symbol}\n\n`;
  
  msg += "--- \n_Report Generated: " + Utilities.formatDate(new Date(), "GMT", "yyyy-MM-dd HH:mm:ss") + " (UTC)_";
  return msg;
}

function sendToTelegram(text) {
  var url = 'https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage';
  const ctaText = '[🔥Earn 5% commission on transactions](https://fx.aladdin.club/v2/trade/?code=nyaconeco)';

  CHAT_IDS.forEach(function(c) {
    try {
      var originalPayload = { chat_id: c.chat_id, text: text, parse_mode: 'Markdown', disable_web_page_preview: true };
      if (c.message_thread_id) originalPayload.message_thread_id = c.message_thread_id;
      UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(originalPayload), muteHttpExceptions: true });
      
      var ctaPayload = { chat_id: c.chat_id, text: ctaText, parse_mode: 'Markdown', disable_web_page_preview: true };
      if (c.message_thread_id) ctaPayload.message_thread_id = c.message_thread_id;
      UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(ctaPayload), muteHttpExceptions: true });
    } catch (e) {
      console.error('Failed to send Telegram message(s) to ' + c.chat_id + ':', e);
    }
  });
}
