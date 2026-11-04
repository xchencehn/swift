package io.agentstudio.connection;
import org.junit.Test;
import static org.junit.Assert.*;
public final class TokenConnectionTest {
    @Test public void normalizesLanAndPreservesHttpsBasePath() {
        assertEquals("http://192.168.1.10:8792/swift", new TokenConnection(" 192.168.1.10:8792/swift/ ", "test-token").baseUrl);
        assertEquals("https://example.com/swift", new TokenConnection("https://example.com/swift", "test-token").baseUrl);
        assertEquals("http://[::1]:8792/swift", new TokenConnection("http://[::1]:8792/swift", "test-token").baseUrl);
    }
    @Test public void extractsTokenLinkAndAllowsTrustedLocal() {
        TokenConnection link=new TokenConnection("http://192.168.1.10:8792/swift/?token=fixture-secret", "",true);
        assertEquals("fixture-secret",link.token); assertEquals("http://192.168.1.10:8792/swift",link.baseUrl);
        assertEquals("",new TokenConnection("http://127.0.0.1:8792/swift/","",true).token);
    }
    @Test public void refusesCredentialUrlsAndHeaderInjection() {
        for (String address : new String[]{"", "ftp://host", "http://user:pass@host", "http://host?token=secret", "http://host#fragment", "http://host/../x", "http://host/%2e%2e", "http://host:0"}) {
            try { new TokenConnection(address, "test-token"); fail("Invalid address accepted"); } catch (IllegalArgumentException expected) { }
        }
        for (String token : new String[]{"a\r\nb", "a b"}) {
            try { new TokenConnection("http://host", token); fail("Invalid token accepted"); } catch (IllegalArgumentException expected) { }
        }
    }
}
