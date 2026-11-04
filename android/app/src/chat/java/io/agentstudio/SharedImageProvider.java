package io.agentstudio;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 分享图片给别的应用（微信、QQ 等）用的只读 content:// 地址。
 *
 * 这个 APP 没有引入 androidx，没有现成的 FileProvider；这里只做它的一小部分：只读、只给
 * 缓存目录 shared/ 下的文件，名字不许带路径。系统分享面板要文件名和大小，query 给出这两项。
 */
public final class SharedImageProvider extends ContentProvider {
    static final String AUTHORITY_SUFFIX = ".shared";

    static File directory(android.content.Context context) { return new File(context.getCacheDir(), "shared"); }

    static Uri uri(android.content.Context context, String name) {
        return new Uri.Builder().scheme("content").authority(context.getPackageName() + AUTHORITY_SUFFIX).appendPath(name).build();
    }

    private File file(Uri uri) throws FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (name == null || name.contains("/") || name.contains("..") || getContext() == null) throw new FileNotFoundException();
        File target = new File(directory(getContext()), name);
        if (!target.isFile()) throw new FileNotFoundException();
        return target;
    }

    @Override public boolean onCreate() { return true; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new SecurityException("只读");
        return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public String getType(Uri uri) {
        String name = uri.getLastPathSegment();
        return SharedImages.mimeType(null, name);
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        File target;
        try { target = file(uri); } catch (FileNotFoundException error) { return null; }
        MatrixCursor cursor = new MatrixCursor(new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE });
        cursor.addRow(new Object[] { target.getName(), target.length() });
        return cursor;
    }

    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
