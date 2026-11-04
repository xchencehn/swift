package io.agentstudio;
import org.junit.Test;
import static org.junit.Assert.*;
import java.nio.file.Files;
import java.io.File;
import java.io.IOException;
import java.util.Base64;
public class SavedFilesTest {
 @Test public void chunksPreserveBytesAndCleanup() throws Exception {
  File directory=Files.createTempDirectory("swift-save-test").toFile();
  SavedFiles item=new SavedFiles(directory,"test-id","../结果.zip","application/octet-stream");
  try {item.append(Base64.getEncoder().encodeToString(new byte[]{0,-1}));item.append(Base64.getEncoder().encodeToString(new byte[]{3,4}));item.finish();
   assertArrayEquals(new byte[]{0,-1,3,4},Files.readAllBytes(item.file.toPath()));assertEquals("结果.zip",item.name);
   try {item.append("AA==");fail("A finished transfer must reject writes");}catch(IOException expected){}
  } finally {item.close();assertFalse(item.file.exists());directory.delete();}
 }
 @Test public void validatesNamesAndChunks() throws Exception {
  assertEquals("报告.zip",SavedFiles.name("C:\\tmp\\报告.zip"));assertEquals("file",SavedFiles.name(".."));
  File directory=Files.createTempDirectory("swift-save-test").toFile();SavedFiles item=new SavedFiles(directory,"id","x","text/plain; injection");
  try {assertEquals("application/octet-stream",item.mime);try {item.append("not base64!");fail("Invalid chunk");}catch(IOException expected){}}
  finally {item.close();directory.delete();}
 }
}
