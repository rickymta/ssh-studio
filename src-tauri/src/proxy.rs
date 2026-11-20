//! F4: outgoing SOCKS5 (RFC 1928/1929) and HTTP CONNECT proxies for the SSH transport.
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{net::IpAddr, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
};

/// Connects to `target:port` through the proxy and returns the tunnelled stream.
pub async fn connect(
    proxy: &crate::store::Proxy,
    password: Option<String>,
    target: &str,
    port: u16,
) -> anyhow::Result<TcpStream> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
            .await
            .map_err(|e| {
                anyhow::anyhow!(
                    "Không kết nối được proxy {}:{}: {e}",
                    proxy.host,
                    proxy.port
                )
            })?;
        let auth = (!proxy.username.is_empty())
            .then(|| (proxy.username.clone(), password.unwrap_or_default()));
        match proxy.kind.as_str() {
            "socks5" => socks5(&mut stream, auth, target, port).await?,
            "http" => http_connect(&mut stream, auth, target, port).await?,
            other => anyhow::bail!("Kiểu proxy không hỗ trợ: {other}"),
        }
        Ok(stream)
    })
    .await
    .map_err(|_| anyhow::anyhow!("Proxy không phản hồi (quá 30 giây)."))?
}

pub async fn socks5<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    auth: Option<(String, String)>,
    target: &str,
    port: u16,
) -> anyhow::Result<()> {
    let methods: &[u8] = if auth.is_some() {
        &[0x00, 0x02]
    } else {
        &[0x00]
    };
    let mut hello = vec![5, methods.len() as u8];
    hello.extend_from_slice(methods);
    stream.write_all(&hello).await?;
    let mut reply = [0u8; 2];
    stream.read_exact(&mut reply).await?;
    anyhow::ensure!(reply[0] == 5, "Proxy không phải SOCKS5.");
    match reply[1] {
        0x00 => {}
        0x02 => {
            let (user, pass) =
                auth.ok_or_else(|| anyhow::anyhow!("Proxy SOCKS5 yêu cầu đăng nhập."))?;
            anyhow::ensure!(
                user.len() <= 255 && pass.len() <= 255,
                "Username/password proxy quá dài."
            );
            let mut login = vec![1, user.len() as u8];
            login.extend_from_slice(user.as_bytes());
            login.push(pass.len() as u8);
            login.extend_from_slice(pass.as_bytes());
            stream.write_all(&login).await?;
            let mut status = [0u8; 2];
            stream.read_exact(&mut status).await?;
            anyhow::ensure!(status[1] == 0, "Proxy SOCKS5 từ chối username/password.");
        }
        _ => anyhow::bail!("Proxy SOCKS5 không chấp nhận phương thức xác thực nào."),
    }
    let mut request = vec![5, 1, 0];
    match target.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            request.push(1);
            request.extend_from_slice(&ip.octets());
        }
        Ok(IpAddr::V6(ip)) => {
            request.push(4);
            request.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            anyhow::ensure!(target.len() <= 255, "Tên máy quá dài.");
            request.push(3);
            request.push(target.len() as u8);
            request.extend_from_slice(target.as_bytes());
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&request).await?;
    let mut head = [0u8; 4];
    stream.read_exact(&mut head).await?;
    if head[1] != 0 {
        let reason = match head[1] {
            1 => "lỗi chung",
            2 => "luật proxy không cho phép",
            3 => "mạng không tới được",
            4 => "máy không tới được",
            5 => "bị từ chối kết nối",
            6 => "hết thời gian (TTL)",
            7 => "lệnh không hỗ trợ",
            8 => "kiểu địa chỉ không hỗ trợ",
            _ => "lỗi không rõ",
        };
        anyhow::bail!("Proxy SOCKS5 không mở được kết nối tới {target}:{port}: {reason}.");
    }
    // Skip the bound address.
    let skip = match head[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await?;
            len[0] as usize
        }
        _ => anyhow::bail!("Phản hồi SOCKS5 không hợp lệ."),
    };
    let mut rest = vec![0u8; skip + 2];
    stream.read_exact(&mut rest).await?;
    Ok(())
}

pub async fn http_connect<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    auth: Option<(String, String)>,
    target: &str,
    port: u16,
) -> anyhow::Result<()> {
    let authority = if target.contains(':') {
        format!("[{target}]:{port}")
    } else {
        format!("{target}:{port}")
    };
    let mut request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let Some((user, pass)) = auth {
        request += &format!(
            "Proxy-Authorization: Basic {}\r\n",
            STANDARD.encode(format!("{user}:{pass}"))
        );
    }
    request += "\r\n";
    stream.write_all(request.as_bytes()).await?;
    // Read the response head byte by byte so no tunnelled SSH bytes are consumed.
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        anyhow::ensure!(head.len() < 16 * 1024, "Phản hồi proxy HTTP quá dài.");
        let mut byte = [0u8; 1];
        stream.read_exact(&mut byte).await?;
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head);
    let status = head.lines().next().unwrap_or_default();
    let code = status.split_whitespace().nth(1).unwrap_or_default();
    match code {
        "200" => Ok(()),
        "407" => anyhow::bail!("Proxy HTTP yêu cầu đăng nhập hoặc sai username/password (407)."),
        _ => anyhow::bail!("Proxy HTTP từ chối CONNECT: {status}"),
    }
}
