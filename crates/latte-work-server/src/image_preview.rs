//! Bounded raster preview ranges shared by live files and saved comparisons.
use anyhow::{Context, Result, ensure};
use latte_work_protocol::ImagePreviewChunk;
use std::{os::unix::fs::MetadataExt, path::Path};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
pub const LIMIT: u64 = 16 * 1024 * 1024;
pub fn raster(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}
pub fn chunk(
    data: Vec<u8>,
    header: &[u8],
    size: u64,
    offset: u64,
    version: String,
    sha256: Option<String>,
) -> Result<ImagePreviewChunk> {
    ensure!(size <= LIMIT, "图片超过 16 MiB 预览上限");
    ensure!(
        offset <= size && data.len() <= 65536 && offset + data.len() as u64 <= size,
        "图片预览偏移无效"
    );
    let mime = crate::sources::mime(header, Path::new("image"));
    ensure!(
        raster(mime),
        "此版本不是支持预览的 PNG、JPEG、GIF 或 WebP 图片"
    );
    let next = offset + data.len() as u64;
    ensure!(
        next == size || !data.is_empty(),
        "图片在读取期间发生变化，请刷新"
    );
    Ok(ImagePreviewChunk {
        data,
        mime_type: mime.into(),
        size,
        next,
        has_more: next < size,
        version,
        sha256,
    })
}
pub async fn file(
    path: &Path,
    offset: u64,
    version: Option<String>,
    sha256: Option<String>,
) -> Result<ImagePreviewChunk> {
    let metadata = tokio::fs::symlink_metadata(path).await?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "图片预览仅支持普通文件"
    );
    ensure!(
        metadata.len() <= LIMIT && offset <= metadata.len(),
        "图片过大或预览偏移无效"
    );
    let identity = |m: &std::fs::Metadata| {
        format!(
            "{}:{}:{}:{}:{}",
            m.dev(),
            m.ino(),
            m.mtime(),
            m.mtime_nsec(),
            m.len()
        )
    };
    let mut file = tokio::fs::File::open(path).await?;
    ensure!(
        identity(&metadata) == identity(&file.metadata().await?),
        "图片在读取期间发生变化，请刷新"
    );
    let mut header = [0; 512];
    let count = file.read(&mut header).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut data = Vec::new();
    (&mut file).take(65536).read_to_end(&mut data).await?;
    ensure!(
        identity(&metadata) == identity(&file.metadata().await?),
        "图片在读取期间发生变化，请刷新"
    );
    chunk(
        data,
        &header[..count],
        metadata.len(),
        offset,
        version.unwrap_or_else(|| identity(&metadata)),
        sha256,
    )
}
pub fn permit() -> Result<tokio::sync::OwnedSemaphorePermit> {
    static READS: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    READS
        .get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
        .try_acquire_owned()
        .context("图片预览繁忙，请稍后重试")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn image_file_ranges_sniff_bytes_and_reject_scripts_links_and_limits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.png");
        std::fs::write(&path, b"<svg><script>bad</script></svg>").unwrap();
        assert!(file(&path, 0, None, None).await.is_err());
        let mut image = b"\x89PNG\r\n\x1a\n".to_vec();
        image.resize(70000, 0);
        std::fs::write(&path, &image).unwrap();
        let first = file(&path, 0, None, None).await.unwrap();
        let last = file(&path, first.next, None, None).await.unwrap();
        assert_eq!(first.version, last.version);
        assert_eq!(last.data, image[65536..]);
        assert!(!last.has_more);
        assert!(file(&path, 70001, None, None).await.is_err());
        let huge = std::fs::File::create(dir.path().join("huge")).unwrap();
        huge.set_len(LIMIT + 1).unwrap();
        assert!(file(&dir.path().join("huge"), 0, None, None).await.is_err());
        std::os::unix::fs::symlink(&path, dir.path().join("link")).unwrap();
        assert!(file(&dir.path().join("link"), 0, None, None).await.is_err());
    }
}
