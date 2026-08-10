package com.adabala.sandeshika

import android.Manifest
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.adabala.sandeshika.data.db.IngestState
import com.adabala.sandeshika.di.Graph
import com.adabala.sandeshika.ingest.IngestWorker
import com.adabala.sandeshika.ingest.SmsReader
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * P0 shell.
 *
 * NavigationSuiteScaffold gives bottom bar on a phone, navigation rail when
 * unfolded, and a drawer on a tablet -- with no breakpoint code. That is the
 * whole reason this is Compose and not a WebView: the adaptive behaviour the
 * design called for is one component, not a CSS problem.
 *
 * Only Home is implemented, and deliberately as a diagnostics surface: at P0
 * the interesting question is whether ingestion and template mining are
 * actually working on a real inbox. The Money screen lands at P2.
 */
class MainActivity : ComponentActivity() {

    private val requestSms = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            (application as SandeshikaApp).observer.register()
            IngestWorker.enqueueBackfill(this)
            IngestWorker.schedulePeriodicSweep(this, BuildConfig.INGEST_SWEEP_MINUTES)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // Keeps the money dashboard out of the recents thumbnail.
        if (BuildConfig.FLAG_SECURE) {
            window.setFlags(WindowManager.LayoutParams.FLAG_SECURE,
                WindowManager.LayoutParams.FLAG_SECURE)
        }

        setContent {
            MaterialTheme {
                var dest by rememberSaveable { mutableStateOf(Dest.HOME) }
                NavigationSuiteScaffold(
                    navigationSuiteItems = {
                        Dest.entries.forEach { d ->
                            item(
                                selected = d == dest,
                                onClick = { dest = d },
                                icon = { Icon(d.icon, contentDescription = d.label) },
                                label = { Text(d.label) }
                            )
                        }
                    }
                ) {
                    when (dest) {
                        Dest.HOME -> HomeScreen(
                            onGrant = { requestSms.launch(Manifest.permission.READ_SMS) },
                            onBackfill = { IngestWorker.enqueueBackfill(this@MainActivity) }
                        )
                        else -> Placeholder(dest.label)
                    }
                }
            }
        }
    }

    enum class Dest(val label: String, val icon: ImageVector) {
        HOME("Home", Icons.Filled.Home),
        MONEY("Money", Icons.Filled.AccountBalanceWallet),
        ACTIONS("Actions", Icons.Filled.CheckCircle),
        INBOX("Inbox", Icons.Filled.Inbox),
        MORE("More", Icons.Filled.MoreHoriz)
    }
}

@Composable
private fun Placeholder(label: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) {
        Text("$label — arrives in a later phase", style = MaterialTheme.typography.bodyLarge)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeScreen(onGrant: () -> Unit, onBackfill: () -> Unit) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()

    var canRead by remember { mutableStateOf(SmsReader(ctx).canRead()) }
    var stored by remember { mutableStateOf(0) }
    var templates by remember { mutableStateOf(0) }
    var covered by remember { mutableStateOf(0) }
    var onDevice by remember { mutableStateOf(0) }
    var state by remember { mutableStateOf<IngestState?>(null) }

    LaunchedEffect(canRead) {
        canRead = SmsReader(ctx).canRead()
        if (!canRead) return@LaunchedEffect
        onDevice = SmsReader(ctx).totalMessages()
        val db = Graph.database(ctx)
        stored = db.sms().count()
        templates = db.templates().countFlow().first()
        covered = db.templates().coveredMessages()
        state = db.ingestState().get()
    }

    Column(
        Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("సందేశిక", style = MaterialTheme.typography.headlineMedium)
        Text("Sandeshika", style = MaterialTheme.typography.labelLarge)

        if (!canRead) {
            ElevatedCard {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.perm_title),
                        style = MaterialTheme.typography.titleMedium)
                    Text(stringResource(R.string.perm_body),
                        style = MaterialTheme.typography.bodyMedium)
                    Button(onClick = onGrant) { Text(stringResource(R.string.perm_grant)) }
                }
            }
            return@Column
        }

        // P0 is about proving ingestion and mining work on a real inbox, so the
        // home screen reports exactly the numbers that answer that.
        StatCard("Ingestion", listOf(
            "On device" to onDevice.toString(),
            "Stored" to stored.toString(),
            "Backfill" to if (state?.backfillComplete == true) "complete" else "running"
        ))

        val coverage = if (stored > 0) covered * 100 / stored else 0
        StatCard("Template bank", listOf(
            "Templates" to templates.toString(),
            "Coverage" to "$coverage%",
            "Msgs per template" to if (templates > 0) "${stored / templates}" else "—"
        ))

        OutlinedButton(onClick = {
            onBackfill()
            scope.launch { /* stats refresh on next composition */ }
        }) { Text("Run backfill now") }

        Text(
            "Coverage is the share of messages explained by a template seen more " +
                "than once. It is the number that decides how much work Medha " +
                "ever has to do.",
            style = MaterialTheme.typography.bodySmall
        )
    }
}

@Composable
private fun StatCard(title: String, rows: List<Pair<String, String>>) {
    ElevatedCard {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            rows.forEach { (k, v) ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(k, style = MaterialTheme.typography.bodyMedium)
                    Text(v, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}

@Composable
private fun stringResource(id: Int): String =
    androidx.compose.ui.res.stringResource(id)
