// Library root — re-exports modules so that binaries (src/bin/*.rs) can
// access shared code via `use backend::module;`

pub mod db;
pub mod apps;
