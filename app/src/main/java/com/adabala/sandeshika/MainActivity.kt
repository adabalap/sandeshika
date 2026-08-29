package com.adabala.sandeshika

import android.Manifest
import android.content.pm.PackageManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.adabala.sandeshika.classify.Category
import com.adabala.sandeshika.classify.MessageRedactor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { SandeshikaTheme { App() } }
    }
}

// A restrained accent rather than a brand slab. The first cut painted the
// whole header saffron, which read as loud and dated -- current Material
// practice is tonal surfaces carrying the layout and colour reserved for
// things that mean something, which here is the category chips.
private val Accent = Color(0xFFB4531A)
private val AccentDark = Color(0xFFFFB77C)

private val LightScheme = lightColorScheme(
    primary = Accent,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFFDBC7),
    onPrimaryContainer = Color(0xFF3A1600),
    surface = Color(0xFFFFF8F5),
    onSurface = Color(0xFF201A17),
    surfaceVariant = Color(0xFFF4DED4),
    onSurfaceVariant = Color(0xFF52443D),
    outlineVariant = Color(0xFFD7C2B8),
)

private val DarkScheme = darkColorScheme(
    primary = AccentDark,
    onPrimary = Color(0xFF5A2600),
    primaryContainer = Color(0xFF7F3A05),
    onPrimaryContainer = Color(0xFFFFDBC7),
    surface = Color(0xFF1A120E),
    onSurface = Color(0xFFEDE0DA),
    surfaceVariant = Color(0xFF52443D),
    onSurfaceVariant = Color(0xFFD7C2B8),
    outlineVariant = Color(0xFF52443D),
)

@Composable
private fun SandeshikaTheme(content: @Composable () -> Unit) {
    // Explicit schemes rather than dynamic colour. The category chips encode
    // meaning through colour, and a wallpaper-derived palette could quietly
    // collapse two of them into near-identical shades -- which would break
    // the one visual affordance the list depends on.
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkScheme else LightScheme,
        content = content
    )
}

@Composable
private fun App() {
    val context = LocalContext.current
    var granted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS) ==
                PackageManager.PERMISSION_GRANTED
        )
    }
    var asked by remember { mutableStateOf(false) }
    // Both requested together, but only READ_SMS gates the app. Contacts is
    // asked for in the same breath because a second prompt later, out of
    // context, is the kind of thing people reflexively deny.
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        granted = result[Manifest.permission.READ_SMS] == true
        asked = true
    }

    if (granted) {
        InboxScreen()
    } else {
        PermissionGate(asked) {
            launcher.launch(
                arrayOf(Manifest.permission.READ_SMS, Manifest.permission.READ_CONTACTS)
            )
        }
    }
}

@Composable
private fun PermissionGate(alreadyAsked: Boolean, onGrant: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            stringResource(R.string.perm_title),
            fontSize = 20.sp, fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onSurface
        )
        Spacer(Modifier.height(12.dp))
        // Says plainly that nothing leaves the device. That is the whole
        // premise of the app, and it is the question anyone hesitating over
        // an SMS permission prompt is actually asking.
        Text(
            stringResource(R.string.perm_body),
            fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(24.dp))
        Button(onClick = onGrant) { Text(stringResource(R.string.perm_grant)) }
        if (alreadyAsked) {
            Spacer(Modifier.height(16.dp))
            Text(
                stringResource(R.string.perm_denied),
                fontSize = 12.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InboxScreen() {
    val context = LocalContext.current
    var messages by remember { mutableStateOf<List<ClassifiedSms>?>(null) }
    var selectedTab by remember { mutableStateOf(Tab.ALL) }
    var reloadKey by remember { mutableStateOf(0) }

    LaunchedEffect(reloadKey) {
        messages = null
        // Off the main thread: a provider query over hundreds of rows plus
        // classification is not free, and doing it inline drops frames on the
        // very first thing the user sees.
        messages = withContext(Dispatchers.IO) {
            SmsReader.read(context, corrections = CorrectionStore(context))
        }
    }

    val all = messages
    var expanded by remember { mutableStateOf<String?>(null) }
    var showExport by remember { mutableStateOf(false) }
    var correcting by remember { mutableStateOf<ClassifiedSms?>(null) }
    val store = remember { CorrectionStore(context) }

    correcting?.let { target ->
        CorrectionDialog(
            target = target,
            sameShapeCount = all?.count { it.shapeKey == target.shapeKey } ?: 1,
            hasExisting = store.all().containsKey(target.shapeKey),
            onPick = { chosen ->
                store.save(target.shapeKey, chosen, target.sms.body)
                // Applied in memory immediately rather than by rescanning.
                // A rescan of 24,000 messages to reflect one tap would make
                // correcting feel expensive, and the whole point is that it
                // should feel cheap enough to do often.
                messages = all?.map { m ->
                    if (m.shapeKey == target.shapeKey) {
                        m.copy(classification = Classification(chosen, true, CORRECTED_REASON))
                    } else {
                        m
                    }
                }
                correcting = null
            },
            onClear = {
                store.delete(target.shapeKey)
                correcting = null
                reloadKey++
            },
            onDismiss = { correcting = null }
        )
    }

    if (showExport && all != null) {
        ExportDialog(
            messages = all,
            contactNames = SmsReader.knownContactNames,
            onDismiss = { showExport = false }
        )
    }

    // Grouped by sender, most-recent group first.
    //
    // A flat list does not survive real volume: 2,308 offers on a real inbox
    // came from a few dozen senders repeating near-identical text, so
    // scrolling it meant reading the same Bata message twenty times. Grouping
    // turns that into a few dozen rows you can actually scan, and makes
    // "mute this sender" an obvious next step rather than a per-message
    // chore.
    val groups = remember(all, selectedTab) {
        all?.asSequence()
            ?.filter { it.classification.category in selectedTab.categories }
            ?.groupBy { it.displaySender }
            ?.map { (sender, msgs) -> SenderGroup(sender, msgs.sortedByDescending { m -> m.sms.receivedAt }) }
            ?.sortedByDescending { it.messages.first().sms.receivedAt }
            .orEmpty()
    }

    Scaffold(
        topBar = {
            Column(Modifier.background(MaterialTheme.colorScheme.surface)) {
                TopAppBar(
                    title = {
                        Column {
                            Text("Sandeshika", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                            if (all != null) {
                                Text(
                                    stringResource(
                                        R.string.scanned,
                                        all.size,
                                        all.count { it.classification.category == Category.OTHER }
                                    ),
                                    fontSize = 11.5.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    },
                    actions = {
                        TextButton(onClick = { showExport = true }) {
                            Text(stringResource(R.string.export))
                        }
                        TextButton(onClick = { reloadKey++ }) {
                            Text(stringResource(R.string.rescan))
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                        titleContentColor = MaterialTheme.colorScheme.onSurface
                    )
                )
                TabRowScrollable(selectedTab, all) { selectedTab = it }
                Text(
                    stringResource(R.string.long_press_hint),
                    fontSize = 10.5.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 14.dp, end = 14.dp, bottom = 6.dp)
                )
            }
        }
    ) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
            when {
                all == null -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator()
                        Spacer(Modifier.height(12.dp))
                        Text(stringResource(R.string.loading), fontSize = 13.sp)
                    }
                }
                groups.isEmpty() -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Text(
                        stringResource(R.string.empty_tab),
                        color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp
                    )
                }
                else -> LazyColumn(
                    contentPadding = PaddingValues(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    items(groups, key = { it.sender }) { group ->
                        SenderGroupCard(
                            group = group,
                            isExpanded = expanded == group.sender,
                            onToggle = {
                                expanded = if (expanded == group.sender) null else group.sender
                            },
                            onCorrect = { correcting = it }
                        )
                    }
                }
            }
        }
    }
}

/**
 * Horizontally scrollable tabs with live counts.
 *
 * Scrollable rather than fixed: eight tabs do not fit across a phone, and the
 * previous build of this app learned that the hard way when items simply fell
 * off the edge with no indication they existed.
 */
@Composable
private fun TabRowScrollable(
    selected: Tab,
    all: List<ClassifiedSms>?,
    onSelect: (Tab) -> Unit
) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Tab.values().forEach { tab ->
            val count = all?.count { it.classification.category in tab.categories }
            val active = tab == selected
            Surface(
                shape = RoundedCornerShape(20.dp),
                color = if (active) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.surfaceVariant,
                modifier = Modifier.clickable { onSelect(tab) }
            ) {
                Text(
                    text = if (count != null) "${tab.label} $count" else tab.label,
                    color = if (active) MaterialTheme.colorScheme.onPrimary
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                    fontSize = 12.5.sp,
                    fontWeight = if (active) FontWeight.Bold else FontWeight.Normal,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 7.dp)
                )
            }
        }
    }
}

/**
 * Builds, previews and shares the redacted tuning export.
 *
 * Three deliberate properties, each answering a way this could go wrong:
 *
 *  - **Written to a file, not an Intent extra.** A real inbox produced 2,988
 *    shapes; putting that in EXTRA_TEXT exceeded Android's Binder limit and
 *    crashed the app on Share. A file also happens to be what you want for
 *    opening in a spreadsheet.
 *  - **Preview before share, always.** Anything derived from an SMS inbox is
 *    only reasonable to share if the person can read it first.
 *  - **A place to add missed terms.** No redaction ruleset survives contact
 *    with every inbox. Rather than pretending otherwise, the preview is
 *    followed by a field for anything the rules missed, and rebuilding
 *    applies it.
 */
@Composable
private fun ExportDialog(
    messages: List<ClassifiedSms>,
    contactNames: Set<String>,
    onDismiss: () -> Unit
) {
    val context = LocalContext.current
    var built by remember { mutableStateOf<List<MessageRedactor.Template>?>(null) }
    var custom by remember { mutableStateOf("") }
    var allCategories by remember { mutableStateOf(false) }

    fun build() {
        val ctx = MessageRedactor.RedactionContext(
            contactNames = contactNames,
            customTerms = custom.split(",").map { it.trim() }.filter { it.length >= 3 }.toSet()
        )
        built = MessageRedactor.templates(
            messages.map { "" to it.sms },
            onlyUncategorised = !allCategories,
            context = ctx
        )
    }

    fun share(asCsv: Boolean) {
        val templates = built ?: return
        runCatching {
            val dir = java.io.File(context.filesDir, "exports").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() }
            val name = if (asCsv) "sandeshika-shapes.csv" else "sandeshika-shapes.txt"
            val file = java.io.File(dir, name)
            file.writeText(
                if (asCsv) MessageRedactor.renderCsv(templates)
                else MessageRedactor.render(templates, messages.size)
            )
            val uri = androidx.core.content.FileProvider.getUriForFile(
                context, context.packageName + ".exports", file
            )
            context.startActivity(
                Intent.createChooser(
                    Intent(Intent.ACTION_SEND).apply {
                        type = if (asCsv) "text/csv" else "text/plain"
                        putExtra(Intent.EXTRA_STREAM, uri)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    },
                    null
                )
            )
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.export_title)) },
        text = {
            Column(Modifier.heightIn(max = 430.dp).verticalScroll(rememberScrollState())) {
                if (built == null) {
                    Text(stringResource(R.string.export_body), fontSize = 13.sp)
                    Spacer(Modifier.height(12.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = allCategories, onCheckedChange = { allCategories = it })
                        Text(stringResource(R.string.export_all_scope), fontSize = 12.5.sp)
                    }
                } else {
                    val t = built!!
                    Text(
                        stringResource(R.string.export_summary, t.size, t.sumOf { it.count }),
                        fontSize = 12.sp, fontWeight = FontWeight.Bold
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = custom,
                        onValueChange = { custom = it },
                        label = { Text(stringResource(R.string.export_custom), fontSize = 11.sp) },
                        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 12.sp),
                        modifier = Modifier.fillMaxWidth()
                    )
                    TextButton(onClick = { build() }) {
                        Text(stringResource(R.string.export_rebuild), fontSize = 12.sp)
                    }
                    Spacer(Modifier.height(4.dp))
                    Text(
                        MessageRedactor.render(t.take(40), messages.size),
                        fontSize = 10.sp,
                        fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace
                    )
                    if (t.size > 40) {
                        Text(
                            stringResource(R.string.export_truncated, t.size - 40),
                            fontSize = 11.sp, fontWeight = FontWeight.Bold
                        )
                    }
                }
            }
        },
        confirmButton = {
            if (built == null) {
                TextButton(onClick = { build() }) { Text(stringResource(R.string.export_build)) }
            } else {
                Row {
                    TextButton(onClick = { share(true) }) { Text(stringResource(R.string.export_csv)) }
                    TextButton(onClick = { share(false) }) { Text(stringResource(R.string.export_txt)) }
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.export_cancel)) }
        }
    )
}

/** Reason string shown on a message the user has filed themselves. */
private const val CORRECTED_REASON = "you corrected this"

/**
 * Category picker for a single message shape.
 *
 * Shows how many messages the correction will affect, because the honest
 * answer is often "311" and that changes whether someone wants to do it. A
 * picker that silently re-labelled hundreds of messages would be a worse
 * feature than one that asks.
 *
 * OTHER is deliberately absent from the options. "Uncategorised" is what the
 * app says when it does not know; a person choosing it as an answer is really
 * saying "none of these fit", which is feedback worth having but is not the
 * same thing and should not be stored as if it were a label.
 */
@Composable
private fun CorrectionDialog(
    target: ClassifiedSms,
    sameShapeCount: Int,
    hasExisting: Boolean,
    onPick: (Category) -> Unit,
    onClear: () -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.correct_title)) },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                Text(
                    target.sms.body.take(160),
                    fontSize = 12.5.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(Modifier.height(10.dp))
                Text(
                    if (sameShapeCount > 1) {
                        stringResource(R.string.correct_hint, sameShapeCount)
                    } else {
                        stringResource(R.string.correct_hint_single)
                    },
                    fontSize = 11.5.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(Modifier.height(12.dp))
                Category.values().filter { it != Category.OTHER }.forEach { cat ->
                    val selected = cat == target.classification.category
                    Surface(
                        shape = RoundedCornerShape(10.dp),
                        color = if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
                                else MaterialTheme.colorScheme.surface,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 2.dp)
                            .clickable { onPick(cat) }
                    ) {
                        Row(
                            Modifier.padding(horizontal = 10.dp, vertical = 9.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            CategoryChip(cat)
                            Spacer(Modifier.width(10.dp))
                            Text(
                                cat.name.lowercase().replaceFirstChar { it.uppercase() },
                                fontSize = 14.sp,
                                fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                                color = MaterialTheme.colorScheme.onSurface
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            if (hasExisting) {
                TextButton(onClick = onClear) { Text(stringResource(R.string.correct_clear)) }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.correct_cancel)) }
        }
    )
}

private data class SenderGroup(val sender: String, val messages: List<ClassifiedSms>)

/**
 * One sender, collapsed to a single row until tapped.
 *
 * Collapsed shows the newest message and how many others there are, which is
 * what someone scanning a tab actually needs. Expanding is opt-in because at
 * 24,000 messages the default has to be "show me less".
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SenderGroupCard(
    group: SenderGroup,
    isExpanded: Boolean,
    onToggle: () -> Unit,
    onCorrect: (ClassifiedSms) -> Unit
) {
    val newest = group.messages.first()
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f),
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = onToggle,
                // Long-press corrects the newest message in the collapsed
                // view, or the specific message when expanded. Tap stays
                // expand/collapse, because that is what people try first.
                onLongClick = { onCorrect(newest) }
            )
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CategoryChip(newest.classification.category)
                Spacer(Modifier.width(8.dp))
                Text(
                    group.sender,
                    fontSize = 12.5.sp, fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                if (group.messages.size > 1) {
                    Surface(
                        shape = RoundedCornerShape(10.dp),
                        color = MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
                    ) {
                        Text(
                            "${group.messages.size}",
                            fontSize = 11.sp, fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp)
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                }
                Text(
                    formatWhen(newest.sms.receivedAt),
                    fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Spacer(Modifier.height(6.dp))
            if (isExpanded) {
                group.messages.forEach { m ->
                    Column(
                        Modifier
                            .padding(top = 8.dp)
                            .combinedClickable(onClick = {}, onLongClick = { onCorrect(m) })
                    ) {
                        Text(
                            formatWhen(m.sms.receivedAt),
                            fontSize = 10.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Text(
                            m.sms.body,
                            fontSize = 13.5.sp,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                        Text(
                            m.classification.why +
                                if (!m.classification.confident) " · low confidence" else "",
                            fontSize = 10.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            } else {
                Text(
                    newest.sms.body,
                    fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 3, overflow = TextOverflow.Ellipsis
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    newest.classification.why +
                        if (!newest.classification.confident) " · low confidence" else "",
                    fontSize = 10.5.sp,
                    fontWeight = if (newest.classification.why == CORRECTED_REASON)
                        FontWeight.Bold else FontWeight.Normal,
                    color = if (newest.classification.why == CORRECTED_REASON)
                        MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun CategoryChip(cat: Category) {
    val (label, color) = when (cat) {
        Category.TRANSACTION -> "₹" to Color(0xFF1B8A3A)
        Category.BILL -> "Due" to Color(0xFFC0392B)
        Category.OTP -> "Code" to Color(0xFF6A4CB8)
        Category.PROMOTION -> "Ad" to Color(0xFF9E9E9E)
        Category.DELIVERY -> "Box" to Color(0xFF2E86C1)
        Category.TRAVEL -> "Trip" to Color(0xFF117A8B)
        Category.BALANCE -> "Bal" to Color(0xFF7B5E00)
        Category.SPAM -> "Spam" to Color(0xFFB3261E)
        Category.SERVICE -> "Info" to Color(0xFF4A6FA5)
        Category.INSTITUTION -> "Inst" to Color(0xFF6B7C3A)
        Category.PERSONAL -> "You" to Color(0xFFB4531A)
        Category.OTHER -> "?" to Color(0xFFB0A99F)
    }
    Surface(shape = RoundedCornerShape(6.dp), color = color.copy(alpha = 0.14f)) {
        Text(
            label, fontSize = 10.5.sp, fontWeight = FontWeight.Bold, color = color,
            modifier = Modifier.padding(horizontal = 7.dp, vertical = 3.dp)
        )
    }
}

private fun formatWhen(millis: Long): String {
    if (millis <= 0L) return ""
    val now = System.currentTimeMillis()
    val day = 24 * 60 * 60 * 1000L
    return when {
        now - millis < day -> SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(millis))
        now - millis < 7 * day -> SimpleDateFormat("EEE", Locale.getDefault()).format(Date(millis))
        else -> SimpleDateFormat("d MMM", Locale.getDefault()).format(Date(millis))
    }
}
