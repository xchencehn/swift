package io.agentstudio.connection;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/** Direct client-server connections; link credentials are removed before saving the address. */
public final class TokenConnection {
    public final String baseUrl, token;
    public TokenConnection(String address, String token) { this(address, token, false); }
    public TokenConnection(String address, String token, boolean trustedDirect) {
        String value = address == null ? "" : address.trim();
        if (!value.contains("://")) value = "http://" + value;
        String credential = token == null ? "" : token.trim();
        try {
            URI uri = new URI(value);
            if (uri.getRawQuery() != null) for (String field : uri.getRawQuery().split("&")) {
                String[] item=field.split("=",2);
                if (item.length!=2 || !item[0].equals("token")) throw new IllegalArgumentException();
                String entered=URLDecoder.decode(item[1], "UTF-8");
                if (!credential.isEmpty() && !credential.equals(entered)) throw new IllegalArgumentException();
                credential=entered;
            }
            String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
            String path = uri.getRawPath() == null ? "" : uri.getRawPath().replaceAll("/+$", "");
            if ((!scheme.equals("http") && !scheme.equals("https")) || uri.getHost() == null
                    || uri.getRawUserInfo() != null || uri.getRawFragment() != null
                    || uri.getPort() == 0 || uri.getPort() > 65535 || !path.matches("(?:/[A-Za-z0-9._~-]+)*"))
                throw new IllegalArgumentException();
            for (String segment : path.split("/")) if (segment.equals(".") || segment.equals("..")) throw new IllegalArgumentException();
            baseUrl = scheme + "://" + uri.getRawAuthority() + path;
        } catch (Exception e) { throw new IllegalArgumentException("请输入正确的电脑地址，例如 http://192.168.1.10:8792/swift"); }
        this.token = credential;
        if (this.token.length() > 4096 || (!this.token.isEmpty() && !this.token.matches("[!-~]+")))
            throw new IllegalArgumentException("请输入有效的 token。");
    }
    public static final class AuthenticationException extends IOException {
        AuthenticationException() { super("token 不正确或已失效，请重新输入。"); }
    }
    /** Credentials never enter the URL or cross an HTTP redirect. */
    public String verify() throws IOException { return read("/api/config"); }
    private String read(String endpoint) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + endpoint).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(12000); connection.setReadTimeout(12000);
        if (!token.isEmpty()) connection.setRequestProperty("x-agent-studio-token", token);
        connection.setRequestProperty("Accept", "application/json");
        try {
            int status = connection.getResponseCode();
            if (status == 401 || status == 403) throw new AuthenticationException();
            if (status >= 300 && status < 400) throw new IOException("地址发生跳转，请填写最终的 Swift 服务地址。");
            if (status == 503) throw new IOException("执行端尚未上线，请检查服务器。");
            if (status != 200) throw new IOException("服务暂时不可用，请检查电脑地址。");
            String type = connection.getContentType();
            if (type == null || !type.toLowerCase(Locale.ROOT).startsWith("application/json"))
                throw new IOException("这个地址不是 Swift 服务，请检查端口和路径。");
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > 1024 * 1024) throw new IOException("服务响应过大。");
                    output.write(buffer, 0, count);
                }
                return output.toString(StandardCharsets.UTF_8.name());
            }
        } finally { connection.disconnect(); }
    }
}
