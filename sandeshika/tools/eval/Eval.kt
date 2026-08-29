import com.adabala.sandeshika.classify.*
import java.io.File

/** Runs the real classifier over the real corpus and reports coverage. */
fun main() {
    var total = 0; var other = 0
    val byCat = mutableMapOf<Category, Int>()
    val misses = mutableListOf<Pair<Int, String>>()
    File("/tmp/sk/corpus.tsv").forEachLine { line ->
        val p = line.split("\t", limit = 3)
        if (p.size == 3) {
            val n = p[0].toIntOrNull() ?: 0
            val c = RuleClassifier.classify(Sms(p[1], p[2])).category
            total += n; byCat[c] = (byCat[c] ?: 0) + n
            if (c == Category.OTHER) { other += n; misses.add(n to "${p[1]} | ${p[2].take(88)}") }
        }
    }
    println("messages=$total  uncategorised=$other (" + "%.1f".format(100.0 * other / total) + "%)")
    byCat.entries.sortedByDescending { it.value }.forEach {
        println("  " + it.key.toString().padEnd(12) + it.value)
    }
    println("\ntop remaining misses:")
    misses.sortedByDescending { it.first }.take(14).forEach { println("[" + it.first + "x] " + it.second) }
}
