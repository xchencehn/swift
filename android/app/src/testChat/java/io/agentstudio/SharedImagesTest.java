package io.agentstudio;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class SharedImagesTest {
    @Test public void onlyImagesPass() {
        assertEquals("image/png", SharedImages.mimeType("image/png", "x"));
        assertEquals("image/jpeg", SharedImages.mimeType("", "photo.JPG"));
        assertNull("这条通道只给图片用", SharedImages.mimeType("text/html", "page.html"));
    }

    @Test public void fileNameHasNoPathAndMatchesType() {
        assertEquals("架构图.png", SharedImages.fileName("/home/u/docs/架构图.png", "image/png"));
        assertEquals("secret.png", SharedImages.fileName("../../secret", "image/png"));
        assertEquals("shot.jpg", SharedImages.fileName("shot.png", "image/jpeg"));
        assertEquals("photo.jpeg", SharedImages.fileName("photo.jpeg", "image/jpeg"));
        assertEquals("image.png", SharedImages.fileName("", "image/png"));
        assertEquals("a b.png", SharedImages.fileName("a\u0000 b.png", "image/png"));
    }

    @Test public void decodeRejectsBadInput() {
        assertArrayEquals(new byte[] { 1, 2, 3 }, SharedImages.decode("AQID"));
        assertNull(SharedImages.decode("@@@"));
        assertNull(SharedImages.decode(null));
    }
}
