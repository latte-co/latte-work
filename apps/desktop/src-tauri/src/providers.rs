//! The native App owns provider configuration; never route management through a host.
use crate::Connections;
use latte_work_config::ProviderStore;
use latte_work_protocol::{Request, Response};
use tauri::{Manager, State};

pub async fn with_store<T: Send + 'static>(
    app: tauri::AppHandle,
    operation: impl FnOnce(&mut ProviderStore) -> anyhow::Result<T> + Send + 'static,
) -> Result<T, String> {
    let directory = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let legacy = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join(".local/share/latte-work/providers.json");
    tokio::task::spawn_blocking(move || {
        let mut store = ProviderStore::open(&directory, Some(&legacy))?;
        operation(&mut store)
    })
    .await
    .map_err(|_| "App Provider 配置任务失败".to_owned())?
    .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn provider_request(app: tauri::AppHandle, request: Request) -> Result<Response, String> {
    with_store(app, move |store| match request {
        Request::Providers => Ok(store.list()),
        Request::SaveProvider { provider } => store.save(provider),
        Request::DeleteProvider { id } => store.delete(&id),
        _ => anyhow::bail!("此入口仅支持 App Provider 配置"),
    })
    .await
}

#[tauri::command]
pub async fn agent_providers(app: tauri::AppHandle, host_id: String) -> Result<Response, String> {
    with_store(app, move |store| store.list_for_host(&host_id)).await
}

#[tauri::command]
pub async fn bind_agent_provider(
    app: tauri::AppHandle,
    state: State<'_, Connections>,
    host_id: String,
    agent: String,
    provider_id: Option<String>,
) -> Result<Response, String> {
    // Compatibility comes from the selected host's advertised capabilities, never
    // the local Agent registry. Clearing a choice needs no online Agent at all.
    let protocols = if provider_id.is_some() {
        let client = state
            .clients
            .lock()
            .await
            .get(&host_id)
            .cloned()
            .ok_or("Host 未连接")?;
        let response = client
            .lock()
            .await
            .request(Request::Hello {
                version: latte_work_protocol::VERSION,
            })
            .await
            .map_err(|e| e.to_string())?;
        match response {
            Response::Hello { agents, .. } => {
                agents
                    .into_iter()
                    .find(|a| a.id == agent)
                    .ok_or("此主机不支持该 Agent")?
                    .provider_protocols
            }
            Response::Error { message, .. } => return Err(message),
            _ => return Err("Agent 响应格式不匹配".into()),
        }
    } else {
        vec![]
    };
    with_store(app, move |store| {
        if let Some(id) = &provider_id {
            let Response::Providers { providers, .. } = store.list() else {
                unreachable!()
            };
            let provider = providers
                .iter()
                .find(|p| &p.id == id)
                .ok_or_else(|| anyhow::anyhow!("Provider 不存在"))?;
            if !protocols.contains(&provider.protocol) {
                anyhow::bail!("此 Code Agent 不支持所选 Provider 的协议");
            }
        }
        store.bind(&host_id, &agent, provider_id)
    })
    .await
}

#[tauri::command]
pub async fn fetch_provider_models(
    app: tauri::AppHandle,
    provider: latte_work_protocol::ProviderDraft,
) -> Result<Vec<latte_work_config::discovery::DiscoveredModel>, String> {
    let endpoint = with_store(app, move |store| store.model_endpoint(provider)).await?;
    tokio::task::spawn_blocking(move || endpoint.fetch())
        .await
        .map_err(|_| "获取模型任务失败".to_owned())?
        .map_err(|e| e.to_string())
}
