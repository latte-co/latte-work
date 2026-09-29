//! Bounded model discovery for the native application; secrets never enter responses.
use anyhow::{Context, Result, bail};
use latte_work_protocol::{ProviderAuth, ProviderProtocol};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::Read,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredModel {
    pub id: String,
    pub name: String,
}
// Deliberately not Debug/Serialize: this contains a credential.
pub struct ModelEndpoint {
    url: url::Url,
    protocol: ProviderProtocol,
    auth: ProviderAuth,
    credential: String,
}
impl ModelEndpoint {
    pub fn new(
        base: String,
        protocol: ProviderProtocol,
        auth: ProviderAuth,
        credential: String,
    ) -> Result<Self> {
        let mut url = url::Url::parse(base.trim()).context("请填写有效的 Base URL")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("Base URL 必须是无凭据和查询参数的 HTTP(S) 地址");
        }
        if credential.len() > 8192 || credential.chars().any(char::is_control) {
            bail!("API Key 格式无效");
        }
        let path = url.path().trim_end_matches('/');
        let path = if path.is_empty() {
            "/v1/models".into()
        } else if path.ends_with("/v1") || protocol != ProviderProtocol::AnthropicMessages {
            format!("{path}/models")
        } else {
            format!("{path}/v1/models")
        };
        url.set_path(&path);
        Ok(Self {
            url,
            protocol,
            auth,
            credential,
        })
    }
    pub fn fetch(self) -> Result<Vec<DiscoveredModel>> {
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .build()
            .context("无法初始化模型请求")?;
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut models = BTreeMap::new();
        let mut cursor = String::new();
        for _ in 0..5 {
            let mut url = self.url.clone();
            if self.protocol == ProviderProtocol::AnthropicMessages {
                url.query_pairs_mut().append_pair("limit", "1000");
            }
            if !cursor.is_empty() {
                url.query_pairs_mut().append_pair("after_id", &cursor);
            }
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .context("获取模型超时")?;
            let mut request = client.get(url).timeout(remaining);
            request = match self.auth {
                ProviderAuth::None => request,
                ProviderAuth::Bearer => request.bearer_auth(&self.credential),
                ProviderAuth::ApiKey => request.header("x-api-key", &self.credential),
            };
            if self.protocol == ProviderProtocol::AnthropicMessages {
                request = request.header("anthropic-version", "2023-06-01");
            }
            let response = request
                .send()
                .map_err(|_| anyhow::anyhow!("无法获取模型，请检查地址、连接或证书"))?;
            if !response.status().is_success() {
                bail!(
                    "获取模型失败（HTTP {}），请检查 API Key 或模型目录接口",
                    response.status().as_u16()
                );
            }
            let mut body = Vec::new();
            response
                .take(1024 * 1024 + 1)
                .read_to_end(&mut body)
                .context("无法读取模型目录")?;
            if body.len() > 1024 * 1024 {
                bail!("模型目录响应超过 1 MB");
            }
            let value: serde_json::Value = serde_json::from_slice(&body)
                .map_err(|_| anyhow::anyhow!("模型目录响应不是有效 JSON"))?;
            let data = value
                .get("data")
                .and_then(|v| v.as_array())
                .context("接口未返回 data 模型列表")?;
            for item in data {
                let id = item
                    .get("id")
                    .and_then(|v| v.as_str())
                    .context("模型缺少 ID")?;
                let name = item
                    .get("display_name")
                    .or_else(|| item.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(id);
                if id.is_empty()
                    || id.len() > 256
                    || id.starts_with('-')
                    || id.chars().any(|c| c.is_whitespace() || c.is_control())
                    || name.chars().count() > 80
                    || name.chars().any(char::is_control)
                {
                    bail!("后端返回了无效的模型 ID 或显示名称");
                }
                models.entry(id.to_owned()).or_insert(name.to_owned());
                if models.len() > 256 {
                    bail!("后端返回超过 256 个模型，请手动添加需要的模型");
                }
            }
            if value.get("has_more").and_then(|v| v.as_bool()) != Some(true) {
                return Ok(models
                    .into_iter()
                    .map(|(id, name)| DiscoveredModel { id, name })
                    .collect());
            }
            let next = value
                .get("last_id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty() && *s != cursor)
                .context("模型目录分页游标无效")?;
            cursor = next.to_owned();
        }
        bail!("模型目录分页超过限制")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
    };
    fn fixture(response: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", socket.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = socket.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                request.push_str(&line);
            }
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            request
        });
        (base, thread)
    }
    #[test]
    fn models_use_protocol_auth_and_preserve_names() {
        for (protocol, auth, header) in [
            (
                ProviderProtocol::AnthropicMessages,
                ProviderAuth::ApiKey,
                "x-api-key: fixture",
            ),
            (
                ProviderProtocol::OpenaiChat,
                ProviderAuth::Bearer,
                "authorization: Bearer fixture",
            ),
            (ProviderProtocol::OpenaiResponses, ProviderAuth::None, ""),
        ] {
            let (base, thread) =
                fixture(r#"{"data":[{"id":"model","display_name":"Friendly"}],"has_more":false}"#);
            let endpoint = ModelEndpoint::new(base, protocol, auth, "fixture".into()).unwrap();
            let models = endpoint.fetch().unwrap();
            assert_eq!(models[0].id, "model");
            assert_eq!(models[0].name, "Friendly");
            let request = thread.join().unwrap();
            assert!(request.starts_with("GET /v1/models"));
            if header.is_empty() {
                assert!(!request.contains("authorization:"));
                assert!(!request.contains("x-api-key:"));
            } else {
                assert!(request.contains(header));
            }
        }
    }
    #[test]
    fn preserves_gateway_prefix_and_rejects_invalid_response() {
        let (base, thread) = fixture(r#"{"unexpected":[]}"#);
        let endpoint = ModelEndpoint::new(
            format!("{base}/gateway/v1/"),
            ProviderProtocol::OpenaiResponses,
            ProviderAuth::None,
            String::new(),
        )
        .unwrap();
        assert!(endpoint.fetch().unwrap_err().to_string().contains("data"));
        assert!(thread.join().unwrap().starts_with("GET /gateway/v1/models"));
    }
}
