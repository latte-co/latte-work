//! Traex-specific metadata and Provider capabilities over the shared app-server engine.
#[path = "traex_metadata.rs"]
mod metadata;
#[path = "traex_provider.rs"]
pub(super) mod provider;
pub(super) use super::app_server::AppServer as Traex;
pub(crate) use metadata::{ModelSelection, models, validate_selection};
pub(super) use metadata::{discover, permission_modes};
pub(super) use metadata::{models_for_agent, output};
