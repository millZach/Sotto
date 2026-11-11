import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Random;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * A phone on OkHttp, the library the Android client connects with (ADR-0059), for
 * `tests/integration/socketOkHttpInterop.test.ts` (#2394). It says hello, reads one long thread, then stages two
 * photos, each a compressed message of a few hundred kilobytes, and closes. It prints sizes and SHA-256 hashes only:
 *
 *   EXTENSIONS <what the host answered the offer OkHttp makes by itself>
 *   MESSAGE <request id> <bytes of the message read> <its hash>
 *   PHOTO <request id> <bytes of the photo sent> <its hash>
 *   CLOSED <code>
 *
 * Run by the test as `java -cp <OkHttp, Okio and the Kotlin standard library> OkHttpPhone.java <port> <session>`.
 */
public class OkHttpPhone {
  private static final Pattern ID = Pattern.compile("\"id\":\"([^\"]+)\"");
  private static final int PHOTO_BYTES = 300 * 1024;

  private static String sha256(byte[] bytes) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
  }

  /** A photo's worth of bytes that do not compress, as a JPEG's do not, the same for a seed on every run. */
  private static String photo(String id, String session, long seed) throws Exception {
    byte[] bytes = new byte[PHOTO_BYTES];
    new Random(seed).nextBytes(bytes);
    System.out.println("PHOTO " + id + " " + bytes.length + " " + sha256(bytes));
    return "{\"v\":1,\"id\":\"" + id + "\",\"session\":\"" + session + "\",\"op\":\"stage-attachment\",\"image\":{\"name\":\"" + id
      + ".jpg\",\"mimeType\":\"image/jpeg\",\"data\":\"" + Base64.getEncoder().encodeToString(bytes) + "\"}}";
  }

  public static void main(String[] args) throws Exception {
    String port = args[0], session = args[1];
    CountDownLatch done = new CountDownLatch(1);
    int[] exit = { 1 };
    OkHttpClient client = new OkHttpClient();
    Request request = new Request.Builder().url("ws://127.0.0.1:" + port + "/v1/socket").header("Authorization", "Bearer " + session).build();
    client.newWebSocket(request, new WebSocketListener() {
      @Override public void onOpen(WebSocket socket, Response response) {
        System.out.println("EXTENSIONS " + response.header("Sec-WebSocket-Extensions"));
        socket.send("{\"v\":1,\"id\":\"hello\",\"session\":\"" + session + "\",\"op\":\"hello\"}");
      }
      @Override public void onMessage(WebSocket socket, String text) {
        try {
          // A reply's own id comes before its result; a pushed event has none there.
          Matcher found = ID.matcher(text.substring(0, Math.min(text.length(), 80)));
          if (!found.find()) return;
          String id = found.group(1);
          System.out.println("MESSAGE " + id + " " + text.getBytes(StandardCharsets.UTF_8).length + " " + sha256(text.getBytes(StandardCharsets.UTF_8)));
          switch (id) {
            case "hello" -> socket.send("{\"v\":1,\"id\":\"long\",\"session\":\"" + session + "\",\"op\":\"detail\",\"threadId\":\"long\"}");
            case "long" -> socket.send(photo("photo-1", session, 1));
            case "photo-1" -> socket.send(photo("photo-2", session, 2));
            case "photo-2" -> socket.close(1000, "done");
            default -> { }
          }
        } catch (Exception error) { System.out.println("FAILURE " + error.getClass().getSimpleName()); done.countDown(); }
      }
      @Override public void onClosing(WebSocket socket, int code, String reason) { socket.close(code, null); }
      @Override public void onClosed(WebSocket socket, int code, String reason) { System.out.println("CLOSED " + code); exit[0] = code == 1000 ? 0 : 1; done.countDown(); }
      @Override public void onFailure(WebSocket socket, Throwable error, Response response) { System.out.println("FAILURE " + error.getClass().getSimpleName()); done.countDown(); }
    });
    if (!done.await(60, TimeUnit.SECONDS)) System.out.println("FAILURE Timeout");
    client.dispatcher().executorService().shutdownNow();
    System.exit(exit[0]);
  }
}
