//! Logging setup that tees `log` records into telemetry.
//!
//! Wraps the normal `env_logger` so stdout logging is unchanged, but every
//! `warn!`/`error!` record is *also* emitted as a `log` telemetry event — so
//! backend errors become queryable in ClickHouse instead of living only in
//! container stdout. Telemetry's own module is skipped to avoid a feedback loop
//! (a failing ingest POST logs a warning, which must not re-enqueue forever).

use log::{Level, Log, Metadata, Record};

use super::{Event, Severity};

struct TeeLogger {
    inner: env_logger::Logger,
}

impl Log for TeeLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        self.inner.enabled(metadata)
    }

    fn log(&self, record: &Record) {
        // Always do the normal stdout logging first.
        self.inner.log(record);

        if record.level() > Level::Warn {
            return; // only forward warnings and errors
        }
        let target = record.target();
        if target.contains("apps::telemetry") {
            return; // never forward telemetry's own logs (loop guard)
        }
        let severity = match record.level() {
            Level::Error => Severity::Error,
            _ => Severity::Warn,
        };
        Event::new("log", record.level().as_str(), severity)
            .msg(record.args())
            .route(target)
            .emit();
    }

    fn flush(&self) {
        self.inner.flush();
    }
}

/// Install the tee logger. Replaces `env_logger::init()`. Honours `RUST_LOG`
/// exactly as before for the stdout side.
pub fn init() {
    let inner = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .build();
    let level = inner.filter();
    if log::set_boxed_logger(Box::new(TeeLogger { inner })).is_ok() {
        log::set_max_level(level);
    }
}
