import io.agentstudio.connection.TokenConnection;
public final class TokenClient {
    private static void rejected(Runnable operation) {
        try { operation.run(); throw new AssertionError("Invalid connection accepted"); }
        catch (IllegalArgumentException expected) { }
    }
    private static void failure(String address, String token) throws Exception {
        try { new TokenConnection(address, token).verify(); throw new AssertionError("Invalid response accepted"); }
        catch (java.io.IOException expected) { }
    }
    public static void main(String[] args) throws Exception {
        String base = args[0];
        if (!new TokenConnection(base + "/trusted", "", true).verify().contains("\"ok\":true")) throw new AssertionError("Trusted direct connection required a token");
        TokenConnection linked=new TokenConnection(base+"/?token=fixture-direct-token", "", true);
        if(!linked.token.equals("fixture-direct-token") || linked.baseUrl.contains("token="))throw new AssertionError("Connection link was not separated");
        linked.verify();
        if (!new TokenConnection(base + "/", "fixture-direct-token").verify().contains("\"ok\":true")) throw new AssertionError();
        new TokenConnection(base, "fixture-android-token").verify();
        failure(base, "wrong-token"); failure(base + "/redirect", "fixture-direct-token");
        failure(base + "/html", "fixture-direct-token"); failure(base + "/large", "fixture-direct-token");
        for (String value : new String[]{"", "ftp://host", "http://user:pass@host", "http://host?token=secret", "http://host#token", "http://host/../x", "http://host/%2e%2e", "http://host:0", "http://host:65536"})
            rejected(() -> new TokenConnection(value, "fixture-direct-token"));
        for (String token : new String[]{"a\r\nb", "a b"}) rejected(() -> new TokenConnection(base, token));
        if (!new TokenConnection("192.168.1.10:8792/swift/", "fixture-direct-token").baseUrl.equals("http://192.168.1.10:8792/swift")) throw new AssertionError();
        if (!new TokenConnection("https://example.com/swift", "fixture-direct-token").baseUrl.startsWith("https://")) throw new AssertionError();
        System.out.println("PASS: Java token verification, address validation, rejected tokens and redirects");
    }
}
