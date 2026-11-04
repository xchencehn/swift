package io.agentstudio;

import java.util.Base64;
import java.util.Locale;

/**
 * 网页交给原生保存、分享的图片：类型判断与文件名清理。不引用 Android 类型，单元测试直接跑
 * （AGENTS.md：没有真机，解析与判定一律拆成纯 Java 类）。
 */
final class SharedImages {
    /** 网页一次最多交过来这么大（原始字节）。更大的走 base64 跨桥就太慢了。 */
    static final int MAX_BYTES = 20 * 1024 * 1024;

    private SharedImages() {}

    /** 只认常见的图片类型；认不出返回 null —— 这条通道只给图片用。 */
    static String mimeType(String declared, String name) {
        String type = declared == null ? "" : declared.toLowerCase(Locale.ROOT).trim();
        switch (type) {
            case "image/png": case "image/jpeg": case "image/gif": case "image/webp": case "image/svg+xml": return type;
            default: break;
        }
        String lower = name == null ? "" : name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        return null;
    }

    static String extension(String mime) {
        switch (mime) {
            case "image/png": return ".png";
            case "image/jpeg": return ".jpg";
            case "image/gif": return ".gif";
            case "image/webp": return ".webp";
            case "image/svg+xml": return ".svg";
            default: return "";
        }
    }

    /** 只留文件名本身：去掉目录、控制字符与路径分隔符，限长，扩展名与类型一致。 */
    static String fileName(String name, String mime) {
        String base = name == null ? "" : name;
        int slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (slash >= 0) base = base.substring(slash + 1);
        base = base.replaceAll("[\\p{Cntrl}:*?\"<>|]", "").trim();
        if (base.startsWith(".")) base = base.replaceFirst("^\\.+", "");
        String ext = extension(mime);
        if (!ext.isEmpty() && !base.toLowerCase(Locale.ROOT).endsWith(ext)
                && !(ext.equals(".jpg") && base.toLowerCase(Locale.ROOT).endsWith(".jpeg"))) {
            int dot = base.lastIndexOf('.');
            if (dot > 0) base = base.substring(0, dot);
            base = base + ext;
        }
        if (base.length() > 80) base = base.substring(base.length() - 80);
        return base.isEmpty() || base.equals(ext) ? "image" + ext : base;
    }

    /** 解码网页交过来的 base64；超限或格式不对返回 null。 */
    static byte[] decode(String base64) {
        if (base64 == null || base64.length() > (MAX_BYTES / 3 + 1) * 4) return null;
        try { return Base64.getDecoder().decode(base64); } catch (IllegalArgumentException error) { return null; }
    }
}
