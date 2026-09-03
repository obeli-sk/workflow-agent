//! Per-script watch join set: one interrupt-offer stub child plus an optional
//! watchdog delay, observed by the interpreter seams at durable boundaries
//! (`just_bash_rs::ScriptWatch`). Operator interrupt and timeout are the same
//! mechanism with different payloads, and both are journaled children, so
//! replay reproduces the exact unwind point. Dropping the guard closes the
//! set, cancelling whichever children are still outstanding (the unfulfilled
//! offer on natural completion, a leftover sleep delay after an early wake);
//! on an unwind they are simply left behind in the closing set.

use std::cell::RefCell;
use std::rc::Rc;

use just_bash_rs::{InterruptKind, ScriptWatch, SharedScriptWatch};

use crate::generated::obelisk::log::log::debug as log_line;
use crate::generated::obelisk::types::time::Duration;
use crate::generated::obelisk::workflow::workflow_support::{
    self, DelayId, JoinNextTryError, JoinSet, ResponseId, ScheduleAt,
};
use crate::generated::obelisk_agent::stub_obelisk_ext::stub as session_ext;

struct WatchCore {
    /// `None` once disarmed: dropping the handle closes the set and cancels
    /// its outstanding children.
    join_set: Option<JoinSet>,
    offer_execution_id: String,
    watchdog_delay_id: Option<String>,
}

/// Owns one script's watch join set for the duration of its run.
pub struct ScriptWatchGuard {
    core: Rc<RefCell<WatchCore>>,
}

impl ScriptWatchGuard {
    /// Submit the interrupt offer, plus the watchdog when `timeout_ms` is set,
    /// onto a fresh join set.
    pub fn arm(timeout_ms: Option<u64>) -> Self {
        log_line(&format!(
            "script-watch arm: creating join set, timeout_ms={timeout_ms:?}"
        ));
        let join_set = workflow_support::join_set_create();
        let offer = session_ext::interrupt_submit(&join_set);
        log_line(&format!(
            "script-watch arm: interrupt offer submitted, offer_execution_id={}",
            offer.id
        ));
        let watchdog = timeout_ms.map(|ms| {
            workflow_support::submit_delay(&join_set, ScheduleAt::In(Duration::Milliseconds(ms)))
        });
        if let Some(delay) = &watchdog {
            log_line(&format!(
                "script-watch arm: watchdog delay submitted, watchdog_delay_id={}",
                delay.id
            ));
        }
        Self {
            core: Rc::new(RefCell::new(WatchCore {
                join_set: Some(join_set),
                offer_execution_id: offer.id,
                watchdog_delay_id: watchdog.map(|delay: DelayId| delay.id),
            })),
        }
    }

    pub fn offer_execution_id(&self) -> String {
        self.core.borrow().offer_execution_id.clone()
    }

    /// Handle for `Bash::set_script_watch`, sharing the guard's state so the
    /// interpreter observes the same set the guard drops.
    pub fn watcher(&self) -> SharedScriptWatch {
        let cell: Rc<RefCell<ScriptWatcher>> =
            Rc::new(RefCell::new(ScriptWatcher(self.core.clone())));
        cell
    }
}

struct ScriptWatcher(Rc<RefCell<WatchCore>>);

impl ScriptWatcher {
    /// What a completed response means for this script. Anything else
    /// (responses from earlier children of the session cannot appear here:
    /// the set is fresh per script) keeps the drain going.
    fn classify(core: &WatchCore, response: ResponseId) -> Option<InterruptKind> {
        match response {
            ResponseId::ExecutionId(execution) if execution.id == core.offer_execution_id => {
                Some(InterruptKind::Operator)
            }
            ResponseId::DelayId(delay)
                if core.watchdog_delay_id.as_deref() == Some(delay.id.as_str()) =>
            {
                Some(InterruptKind::Timeout)
            }
            _ => None,
        }
    }
}

impl ScriptWatch for ScriptWatcher {
    fn poll(&mut self) -> Option<InterruptKind> {
        let core = self.0.borrow();
        let join_set = core.join_set.as_ref()?;
        // Drain processed responses until a signal shows up or nothing
        // processed remains; each peek is a journaled host call, so replay
        // sees the same unwind point.
        loop {
            match workflow_support::join_next_try(join_set) {
                Err(JoinNextTryError::Pending | JoinNextTryError::AllProcessed) => return None,
                Ok(_) => {
                    let kind = join_set.last_id().and_then(|id| Self::classify(&core, id));
                    if kind.is_some() {
                        return kind;
                    }
                }
            }
        }
    }

    fn sleep(&mut self, ms: u64) -> Result<(), InterruptKind> {
        if ms == 0 {
            return Ok(());
        }
        let core = self.0.borrow();
        let Some(join_set) = core.join_set.as_ref() else {
            return Ok(());
        };
        let own_delay =
            workflow_support::submit_delay(join_set, ScheduleAt::In(Duration::Milliseconds(ms)));
        loop {
            // The set always has pending requests here (its own delay at the
            // least), so the blocking join parks until one lands.
            match workflow_support::join_next(join_set) {
                Ok(_) => match join_set.last_id() {
                    Some(ResponseId::DelayId(delay)) if delay.id == own_delay.id => return Ok(()),
                    Some(response) => {
                        if let Some(kind) = Self::classify(&core, response) {
                            // Our own delay stays behind in the set; the
                            // closing drop cancels it.
                            return Err(kind);
                        }
                    }
                    None => {}
                },
                // Unreachable while pending children exist; treat as elapsed
                // rather than fabricate an interrupt.
                Err(_) => return Ok(()),
            }
        }
    }
}
