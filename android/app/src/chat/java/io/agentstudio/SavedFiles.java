package io.agentstudio;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Base64;

/** One bounded, chunked transfer to private cache before the system file picker. */
final class SavedFiles implements AutoCloseable {
    static final long MAX_BYTES = 64L * 1024 * 1024;
    final String id, name, mime;
    final File file;
    private final FileOutputStream output;
    private long size;
    private boolean finished;

    SavedFiles(File directory, String id, String name, String mime) throws IOException {
        if (id == null || !id.matches("[a-zA-Z0-9-]{1,64}")) throw new IOException("无效的保存请求");
        this.id = id;
        this.name = name(name);
        this.mime = mime != null && mime.matches("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+") ? mime : "application/octet-stream";
        this.file = File.createTempFile("swift-save-", ".part", directory);
        this.output = new FileOutputStream(file);
    }
    static String name(String value) {
        String name = value == null ? "file" : value.replace('\\', '/');
        name = name.substring(name.lastIndexOf('/') + 1).replaceAll("[\\p{Cntrl}:*?\"<>|]", "").replaceFirst("^\\.+", "").trim();
        return name.isEmpty() ? "file" : name.length() > 180 ? name.substring(name.length() - 180) : name;
    }
    synchronized void append(String base64) throws IOException {
        if (finished || base64 == null || base64.length() > 1024 * 1024) throw new IOException("无效的文件分块");
        byte[] bytes;
        try { bytes = Base64.getDecoder().decode(base64); } catch (IllegalArgumentException error) { throw new IOException("文件分块无法解码", error); }
        if (size + bytes.length > MAX_BYTES) throw new IOException("文件超过 64 MB");
        output.write(bytes); size += bytes.length;
    }
    synchronized boolean finished() { return finished; }
    synchronized void finish() throws IOException { output.close(); finished = true; }
    @Override public synchronized void close() throws IOException { try { output.close(); } finally { file.delete(); } }
}
