const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'history/chargers.json');
const TX_FILE = path.join(__dirname, '..', 'history/transactions.json');

class StateTracker {
    constructor() {
        this.chargers = this.loadState(STATE_FILE, {});
        this.transactions = this.loadState(TX_FILE, { active: {}, failed: [], completed: [] });
    }

    loadState(file, defaultValue) {
        try {
            if (fs.existsSync(file)) {
                return JSON.parse(fs.readFileSync(file));
            }
        } catch (e) {
            console.error(`Error loading ${file}:`, e.message);
        }
        return defaultValue;
    }

    saveState() {
        try {
            fs.writeFileSync(STATE_FILE, JSON.stringify(this.chargers, null, 2));
            fs.writeFileSync(TX_FILE, JSON.stringify(this.transactions, null, 2));
        } catch (e) {
            console.error('Error saving state:', e.message);
        }
    }

    // Charger state management
    updateCharger(chargerId, updates) {
        if (!this.chargers[chargerId]) {
            this.chargers[chargerId] = {
                id: chargerId,
                status: 'Unknown',
                lastHeartbeat: null,
                lastMeterValue: null,
                lastEvent: null,
                lastFaultReason: null,
                activeTransaction: null,
                consecutiveErrors: 0,
                needsRestart: false,
                restartReason: '',
                lastStatusChange: new Date().toISOString()
            };
        }

        const charger = this.chargers[chargerId];
        Object.assign(charger, updates);
        charger.lastEvent = new Date().toISOString();

        // Check if charger is healthy (clear restart flag if recovered)
        this.checkChargerHealth(chargerId);
        
        // Auto-detect restart need
        this.checkRestartCondition(chargerId);
    }

    checkChargerHealth(chargerId) {
        const charger = this.chargers[chargerId];
        
        // If not flagged for restart, nothing to clear
        if (!charger.needsRestart) return;
        
        // Check if charger has recovered
        const now = Date.now();
        
        // Recovery signs:
        // 1. Recent heartbeat (<2min)
        if (charger.lastHeartbeat) {
            const timeSinceHeartbeat = now - new Date(charger.lastHeartbeat).getTime();
            if (timeSinceHeartbeat < 2 * 60 * 1000) {
                console.log(`✅ Charger ${chargerId} recovered: recent heartbeat`);
                charger.needsRestart = false;
                charger.restartReason = '';
                charger.consecutiveErrors = 0;
                return;
            }
        }
        
        // 2. Recent MeterValues (<2min)
        if (charger.lastMeterValue) {
            const timeSinceMeterValue = now - new Date(charger.lastMeterValue).getTime();
            if (timeSinceMeterValue < 2 * 60 * 1000) {
                console.log(`✅ Charger ${chargerId} recovered: recent MeterValues`);
                charger.needsRestart = false;
                charger.restartReason = '';
                charger.consecutiveErrors = 0;
                return;
            }
        }
        
        // 3. Status is healthy (Available or Charging) and no errors
        if ((charger.status === 'Available' || charger.status === 'Charging') && charger.consecutiveErrors === 0) {
            console.log(`✅ Charger ${chargerId} recovered: healthy status (${charger.status})`);
            charger.needsRestart = false;
            charger.restartReason = '';
            return;
        }
    }

    checkRestartCondition(chargerId) {
        const charger = this.chargers[chargerId];
        
        // Already flagged (and not recovered in checkChargerHealth)
        if (charger.needsRestart) return;

        // Condition 1: 3+ consecutive errors
        if (charger.consecutiveErrors >= 3) {
            charger.needsRestart = true;
            charger.restartReason = `${charger.consecutiveErrors} erros consecutivos`;
            return;
        }

        // Condition 2: Faulted status
        if (charger.status === 'Faulted') {
            charger.needsRestart = true;
            charger.restartReason = 'Status: Faulted';
            return;
        }

        // Condition 3: Heartbeat timeout > 5 min (ONLY if no active transaction AND no recent MeterValues)
        if (charger.lastHeartbeat) {
            const timeSinceHeartbeat = Date.now() - new Date(charger.lastHeartbeat).getTime();
            if (timeSinceHeartbeat > 5 * 60 * 1000) {
                // Check if there's an active transaction
                if (charger.activeTransaction) {
                    console.log(`⏸️ Heartbeat timeout for ${chargerId}, but transaction active: ${charger.activeTransaction} - NOT flagging for restart`);
                    return;
                }
                
                // Check if we received recent MeterValues (sign of life)
                if (charger.lastMeterValue) {
                    const timeSinceMeterValue = Date.now() - new Date(charger.lastMeterValue).getTime();
                    if (timeSinceMeterValue < 5 * 60 * 1000) {
                        // Charger is alive via MeterValues, silently skip (no log to avoid spam)
                        return;
                    }
                }
                
                charger.needsRestart = true;
                charger.restartReason = 'Heartbeat timeout (>5min)';
                console.log(`⚠️ Heartbeat timeout for ${chargerId}, no active transaction and no recent MeterValues - flagging for restart`);
                return;
            }
        }

        // Condition 4: Transaction stuck (0W for >2 min)
        // (Operationally useful: catches sessions that "started" but never actually deliver power)
        if (charger.activeTransaction) {
            const tx = this.transactions.active[charger.activeTransaction];
            if (tx && tx.powerZeroSince) {
                const zeroTime = Date.now() - new Date(tx.powerZeroSince).getTime();
                if (zeroTime > 2 * 60 * 1000) {
                    charger.needsRestart = true;
                    charger.restartReason = 'Transação travada (0W >2min)';
                    return;
                }
            }
        }
    }

    // Transaction management
    startTransaction(txId, chargerId, data = {}) {
        this.transactions.active[txId] = {
            id: txId,
            chargerId,
            startTime: new Date().toISOString(),
            lastUpdate: new Date().toISOString(),
            powerZeroSince: null,
            ...data
        };

        this.updateCharger(chargerId, { activeTransaction: txId });
    }

    updateTransaction(txId, updates) {
        if (this.transactions.active[txId]) {
            Object.assign(this.transactions.active[txId], updates);
            this.transactions.active[txId].lastUpdate = new Date().toISOString();

            // Track zero power
            if (updates.power !== undefined) {
                if (updates.power === 0 || updates.power === '0.0') {
                    if (!this.transactions.active[txId].powerZeroSince) {
                        this.transactions.active[txId].powerZeroSince = new Date().toISOString();
                    }
                } else {
                    this.transactions.active[txId].powerZeroSince = null;
                }
            }
        }
    }

    endTransaction(txId, reason = 'completed') {
        if (this.transactions.active[txId]) {
            const tx = this.transactions.active[txId];
            tx.endTime = new Date().toISOString();
            tx.endReason = reason;
            tx.stopReason = reason; // alias (more explicit)

            // Move to completed or failed
            if (reason === 'failed') {
                this.transactions.failed.push(tx);
                // Keep only last 50 failed
                if (this.transactions.failed.length > 50) {
                    this.transactions.failed = this.transactions.failed.slice(-50);
                }
            } else {
                this.transactions.completed.push(tx);
                // Keep only last 100 completed
                if (this.transactions.completed.length > 100) {
                    this.transactions.completed = this.transactions.completed.slice(-100);
                }
            }

            // Clear from active
            delete this.transactions.active[txId];

            // Update charger
            if (tx.chargerId && this.chargers[tx.chargerId]) {
                this.chargers[tx.chargerId].activeTransaction = null;
            }
        }
    }

    // Analysis helpers
    getChargersNeedingRestart() {
        return Object.values(this.chargers).filter(c => c.needsRestart);
    }

    getActiveTransactions() {
        return Object.values(this.transactions.active);
    }

    getRecentFailures(minutes = 60) {
        const cutoff = Date.now() - (minutes * 60 * 1000);
        return this.transactions.failed.filter(tx => {
            return new Date(tx.endTime).getTime() > cutoff;
        });
    }

    getRecentUnexpectedStops(minutes = 60) {
        const cutoff = Date.now() - (minutes * 60 * 1000);
        // Treat these as "expected" user/system-initiated stops (not manual pendency):
        // - Local (user pressed stop on charger)
        // - Remote (stop via platform/app)
        // - EVDisconnected (user unplugged)
        const expected = new Set(['Local', 'Remote', 'EVDisconnected', 'completed']);

        return this.transactions.completed
            .filter(tx => new Date(tx.endTime).getTime() > cutoff)
            .filter(tx => !expected.has(tx.endReason));
    }

    getChargerStats() {
        const total = Object.keys(this.chargers).length;
        const statuses = {};
        const needsRestart = [];
        
        Object.values(this.chargers).forEach(c => {
            statuses[c.status] = (statuses[c.status] || 0) + 1;
            if (c.needsRestart) needsRestart.push(c);
        });

        return {
            total,
            statuses,
            needsRestart,
            activeTransactions: Object.keys(this.transactions.active).length
        };
    }
}

module.exports = StateTracker;
