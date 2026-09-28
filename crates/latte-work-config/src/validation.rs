use anyhow::{Result, bail};
use latte_work_protocol::Provider;

pub fn validate_provider(provider: &Provider, credential: &str) -> Result<()> {
    if provider.id.is_empty()
        || provider.id.len() > 100
        || provider.name.is_empty()
        || provider.name.chars().count() > 80
        || provider.name.chars().any(char::is_control)
    {
        bail!("Provider 名称或 ID 无效（名称最多 80 个字符）");
    }
    if provider.base_url.len() > 2048 {
        bail!("Provider 地址过长");
    }
    let url = url::Url::parse(&provider.base_url)
        .map_err(|_| anyhow::anyhow!("请填写有效的 Provider Base URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("Base URL 必须是 HTTP(S) 地址，不能包含用户名、密码、查询参数或片段");
    }
    if provider.models.len() > 64 {
        bail!("每个 Provider 最多配置 64 个模型");
    }
    for model in std::iter::once(&provider.model).chain(provider.models.iter()) {
        if model.is_empty()
            || model.len() > 256
            || model.starts_with('-')
            || model.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            bail!("请填写有效的模型 ID（不能包含空白，最多 256 字节）");
        }
    }
    if credential.trim().is_empty()
        || credential.len() > 8192
        || credential.chars().any(char::is_control)
    {
        bail!("凭据不能为空、超过 8192 字节或包含控制字符");
    }
    Ok(())
}
