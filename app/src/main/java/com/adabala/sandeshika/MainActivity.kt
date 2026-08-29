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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.rememberDrawerState
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import com.adabala.sandeshika.classify.Category
import com.adabala.sandeshika.classify.Classification
import com.adabala.sandeshika.classify.MessageRedactor
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import com.adabala.sandeshika.classify.Dashboard
import com.adabala.sandeshika.classify.DueDateParser
import com.adabala.sandeshika.classify.QuestionRouter
import com.adabala.sandeshika.classify.ReviewQueue
import com.adabala.sandeshika.classify.TransactionParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
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
        HomeScreen()
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

/**
 * Drawer, top bar, and whichever surface is selected.
 *
 * The scan happens inside [InboxScreen] and is shared by both surfaces rather
 * than re-run per screen: re-reading 24,000 messages when switching tabs
 * would be slow, and two surfaces reading at different moments could quietly
 * disagree with each other.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeScreen() {
    val scope = rememberCoroutineScope()
    val drawer = rememberDrawerState(DrawerValue.Closed)
    var screen by remember { mutableStateOf(Screen.DASHBOARD) }
    var showAbout by remember { mutableStateOf(false) }

    if (showAbout) AboutDialog { showAbout = false }

    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet {
                Column(Modifier.padding(20.dp)) {
                    Text(
                        stringResource(R.string.app_name),
                        fontSize = 20.sp, fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.primary
                    )
                    Text(
                        stringResource(R.string.about_privacy),
                        fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                HorizontalDivider()
                NavigationDrawerItem(
                    label = { Text(stringResource(R.string.nav_dashboard)) },
                    selected = screen == Screen.DASHBOARD,
                    onClick = { screen = Screen.DASHBOARD; scope.launch { drawer.close() } },
                    modifier = Modifier.padding(horizontal = 10.dp)
                )
                NavigationDrawerItem(
                    label = { Text(stringResource(R.string.nav_inbox)) },
                    selected = screen == Screen.INBOX,
                    onClick = { screen = Screen.INBOX; scope.launch { drawer.close() } },
                    modifier = Modifier.padding(horizontal = 10.dp)
                )
                NavigationDrawerItem(
                    label = { Text(stringResource(R.string.nav_ask)) },
                    selected = screen == Screen.ASK,
                    onClick = { screen = Screen.ASK; scope.launch { drawer.close() } },
                    modifier = Modifier.padding(horizontal = 10.dp)
                )
                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                NavigationDrawerItem(
                    label = { Text(stringResource(R.string.nav_about)) },
                    selected = false,
                    onClick = { showAbout = true; scope.launch { drawer.close() } },
                    modifier = Modifier.padding(horizontal = 10.dp)
                )
            }
        }
    ) {
        InboxScreen(screen = screen, onOpenDrawer = { scope.launch { drawer.open() } })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InboxScreen(screen: Screen = Screen.INBOX, onOpenDrawer: () -> Unit = {}) {
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
    var showReview by remember { mutableStateOf(false) }
    var skipped by remember { mutableStateOf(setOf<String>()) }
    // Declared before every block that reads it. A composable body runs top
    // to bottom like any other function, so a dialog placed above this line
    // cannot see it -- which is exactly how this broke.
    val store = remember { CorrectionStore(context) }

    if (showReview && all != null) {
        ReviewDialog(
            messages = all,
            corrected = store.all().keys + skipped,
            onLabel = { candidate, chosen ->
                store.save(candidate.shapeKey, chosen, candidate.sample.body)
                messages = all.map { m ->
                    if (m.shapeKey == candidate.shapeKey) {
                        m.copy(classification = Classification(chosen, true, CORRECTED_REASON))
                    } else {
                        m
                    }
                }
            },
            // Skipping is remembered for the session only. A shape someone
            // passed over today may be worth asking about once the model has
            // changed around it, and persisting the skip would silently
            // remove it from view forever.
            onSkip = { skipped = skipped + it.shapeKey },
            onDismiss = { showReview = false }
        )
    }

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
                    navigationIcon = {
                        IconButton(onClick = onOpenDrawer) {
                            Icon(Icons.Filled.Menu, contentDescription = stringResource(R.string.menu))
                        }
                    },
                    actions = {
                        TextButton(onClick = { showReview = true }) {
                            Text(stringResource(R.string.review))
                        }
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
                if (screen == Screen.INBOX) {
                TabRowScrollable(selectedTab, all) { selectedTab = it }
                Text(
                    stringResource(R.string.long_press_hint),
                    fontSize = 10.5.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 14.dp, end = 14.dp, bottom = 6.dp)
                )
                }
            }
        }
    ) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
            if (screen == Screen.ASK && all != null) {
                AskScreen(all)
                return@Box
            }
            if (screen == Screen.DASHBOARD && all != null) {
                val stats = remember(all) {
                    Dashboard.compute(all.map { Triple(it.sms, it.classification, it.sms.receivedAt) })
                }
                val queue = remember(all) {
                    ReviewQueue.build(
                        all.map { Triple(it.shapeKey, it.sms, it.classification) },
                        alreadyCorrected = store.all().keys + skipped
                    )
                }
                DashboardScreen(
                    stats = stats,
                    onOpenReview = { showReview = true },
                    reviewReach = queue.size to ReviewQueue.reach(queue)
                )
                return@Box
            }
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

/**
 * Focused labelling flow: one message shape at a time, highest value first.
 *
 * A list would let people browse; a single card makes the decision small
 * enough to actually make. The header states the reach of the whole queue,
 * because "20 shapes covering 1,847 messages" is a reason to start and an
 * unbounded list of problems is a reason not to.
 *
 * Honest about leverage: on a real inbox the top 20 shapes covered only ~2.5%
 * of what needed attention, because that tail is genuinely flat rather than
 * a few big templates. This is worth doing — every label also becomes model
 * training data, so it helps beyond the shape it was given for — but it is
 * not a button that fixes the inbox in one sitting, and presenting it as one
 * would just teach people the app overpromises.
 */
@Composable
private fun ReviewDialog(
    messages: List<ClassifiedSms>,
    corrected: Set<String>,
    onLabel: (ReviewQueue.Candidate, Category) -> Unit,
    onSkip: (ReviewQueue.Candidate) -> Unit,
    onDismiss: () -> Unit
) {
    val queue = remember(messages, corrected) {
        ReviewQueue.build(
            messages.map { Triple(it.shapeKey, it.sms, it.classification) },
            alreadyCorrected = corrected
        )
    }
    val current = queue.firstOrNull()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.review_title)) },
        text = {
            Column(Modifier.heightIn(max = 430.dp).verticalScroll(rememberScrollState())) {
                if (current == null) {
                    Text(stringResource(R.string.review_empty), fontSize = 13.sp)
                    return@Column
                }
                Text(
                    stringResource(R.string.review_reach, queue.size, ReviewQueue.reach(queue)),
                    fontSize = 11.5.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(Modifier.height(10.dp))
                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
                ) {
                    Column(Modifier.padding(10.dp)) {
                        Text(
                            current.sample.sender,
                            fontSize = 11.sp, fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Text(
                            current.sample.body.take(220),
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                    }
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    stringResource(R.string.review_impact, current.impact) + " · " +
                        (current.suggested?.let {
                            stringResource(R.string.review_guess, it.name.lowercase())
                        } ?: stringResource(R.string.review_unknown)),
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(Modifier.height(10.dp))
                Category.values().filter { it != Category.OTHER }.forEach { cat ->
                    Surface(
                        shape = RoundedCornerShape(10.dp),
                        color = MaterialTheme.colorScheme.surface,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 2.dp)
                            .clickable { onLabel(current, cat) }
                    ) {
                        Row(
                            Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            CategoryChip(cat)
                            Spacer(Modifier.width(10.dp))
                            Text(
                                cat.name.lowercase().replaceFirstChar { it.uppercase() },
                                fontSize = 14.sp,
                                color = MaterialTheme.colorScheme.onSurface
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            if (current != null) {
                TextButton(onClick = { onSkip(current) }) {
                    Text(stringResource(R.string.review_skip))
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.review_close)) }
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

/**
 * Natural-language questions over the inbox.
 *
 * Two paths, and which one runs is decided before any model is involved.
 * Anything answerable by arithmetic is computed here and labelled as such,
 * so a spending total never depends on a model getting a sum right. Only
 * questions that need to *read* messages go to Medha, with the app choosing
 * the handful of messages sent as context.
 *
 * Medha being absent degrades the feature rather than breaking it: totals
 * keep working, and the screen says plainly what is unavailable and why.
 */
@Composable
private fun AskScreen(messages: List<ClassifiedSms>) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("medha", Context.MODE_PRIVATE) }
    var client by remember {
        mutableStateOf(
            prefs.getString("token", null)?.let { tok ->
                prefs.getString("base", null)?.let { base -> MedhaClient(base, tok) }
            }
        )
    }
    var question by remember { mutableStateOf("") }
    var answer by remember { mutableStateOf<String?>(null) }
    var computed by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }

    val handshake = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        if (result.resultCode == android.app.Activity.RESULT_OK && data != null) {
            val tok = data.getStringExtra("com.adabala.medha.extra.TOKEN").orEmpty()
            val base = data.getStringExtra("com.adabala.medha.extra.BASE_URL").orEmpty()
            prefs.edit().putString("token", tok).putString("base", base).apply()
            client = MedhaClient(base, tok)
        } else {
            answer = context.getString(R.string.ask_denied)
        }
    }

    fun connect() {
        // Resolved by action, not a fixed package: Medha ships under several
        // applicationIds depending on build variant.
        val probe = Intent("com.adabala.medha.action.REQUEST_ACCESS")
        val target = context.packageManager.queryIntentActivities(probe, 0)
            .map { it.activityInfo.packageName }
            .firstOrNull { it == "com.adabala.medha" || it.startsWith("com.adabala.medha.") }
        if (target == null) {
            answer = context.getString(R.string.ask_no_medha)
            return
        }
        handshake.launch(
            Intent("com.adabala.medha.action.REQUEST_ACCESS").apply {
                setPackage(target)
                putExtra("com.adabala.medha.extra.CAPABILITIES", arrayOf("generate"))
                putExtra(
                    "com.adabala.medha.extra.REASON",
                    "To answer questions about your messages without sending them anywhere"
                )
            }
        )
    }

    val scope = rememberCoroutineScope()

    fun ask() {
        val q = question.trim()
        if (q.isEmpty()) return
        answer = null; computed = false; busy = true
        val pairs = messages.map { it.sms to it.classification }

        // A coroutine rather than a raw thread: state updates have to land on
        // the main thread, and scoping to the composition means an in-flight
        // request is cancelled if this screen goes away instead of writing to
        // state nobody is showing.
        scope.launch {
            when (val plan = QuestionRouter.plan(q, pairs)) {
                is QuestionRouter.Plan.Computed -> {
                    // Deterministic. No model, no network, no uncertainty.
                    answer = plan.answer; computed = true; busy = false
                }
                is QuestionRouter.Plan.NothingFound -> {
                    answer = plan.reason; computed = true; busy = false
                }
                is QuestionRouter.Plan.AskModel -> {
                    val c = client
                    if (c == null) {
                        answer = context.getString(R.string.ask_not_connected)
                        busy = false
                        return@launch
                    }
                    val prompt = QuestionRouter.buildPrompt(plan.question, plan.context)
                    try {
                        val sb = StringBuilder()
                        // Network off the main thread; the collector writes
                        // state back on it via the outer scope.
                        withContext(Dispatchers.IO) {
                            c.chatStream(listOf("user" to prompt)) { delta ->
                                sb.append(delta)
                            }
                        }
                        answer = sb.toString().ifBlank { "(no answer)" }
                    } catch (e: Exception) {
                        answer = context.getString(R.string.ask_error, e.message.orEmpty())
                    } finally {
                        busy = false
                    }
                }
            }
        }
    }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text(
            stringResource(R.string.ask_title),
            fontSize = 18.sp, fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onSurface
        )
        Spacer(Modifier.height(4.dp))
        Text(
            if (client != null) stringResource(R.string.ask_connected)
            else stringResource(R.string.ask_not_connected),
            fontSize = 11.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        if (client == null) {
            Spacer(Modifier.height(8.dp))
            Button(onClick = { connect() }) { Text(stringResource(R.string.ask_connect)) }
        }
        Spacer(Modifier.height(14.dp))
        OutlinedTextField(
            value = question,
            onValueChange = { question = it },
            label = { Text(stringResource(R.string.ask_hint), fontSize = 12.sp) },
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = { ask() }, enabled = !busy) {
                Text(stringResource(R.string.ask_send))
            }
            Spacer(Modifier.width(12.dp))
            if (busy) {
                Text(stringResource(R.string.ask_thinking), fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.height(10.dp))
        Text(
            stringResource(R.string.ask_examples),
            fontSize = 10.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        answer?.let { text ->
            Spacer(Modifier.height(16.dp))
            Surface(
                shape = RoundedCornerShape(14.dp),
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(14.dp).verticalScroll(rememberScrollState())) {
                    Text(text, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface)
                    if (computed) {
                        Spacer(Modifier.height(8.dp))
                        // Says which answers are arithmetic and which came
                        // from a model. They warrant different levels of
                        // trust and the person deserves to know which is which.
                        Text(
                            stringResource(R.string.ask_computed),
                            fontSize = 10.5.sp, fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }
                }
            }
        }
    }
}

/** Which top-level surface is showing. */
private enum class Screen { DASHBOARD, INBOX, ASK }

/**
 * The dashboard.
 *
 * Every money figure comes from the deterministic parser and nothing else,
 * and the count of transactions it could *not* read is shown right next to
 * the total. A number on a screen gets believed — nobody can sanity-check a
 * spending figure derived from 24,000 messages — so the honest move is to
 * state its coverage rather than let it imply completeness it does not have.
 */
@Composable
private fun DashboardScreen(stats: Dashboard.Stats, onOpenReview: () -> Unit, reviewReach: Pair<Int, Int>) {
    var showToday by remember { mutableStateOf(false) }

    if (showToday) {
        TodaySpendDialog(stats) { showToday = false }
    }

    LazyColumn(
        contentPadding = PaddingValues(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            // Today leads, not the month. "What have I spent today" is the
            // question with a decision attached to it; the monthly figure is
            // context and sits below.
            Surface(
                shape = RoundedCornerShape(18.dp),
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.fillMaxWidth().clickable { showToday = true }
            ) {
                Column(Modifier.padding(18.dp)) {
                    Text(
                        stringResource(R.string.dash_today),
                        fontSize = 12.5.sp,
                        color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.85f)
                    )
                    Text(
                        Dashboard.formatRupees(stats.spentToday),
                        fontSize = 38.sp, fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onPrimary
                    )
                    Text(
                        if (stats.todayCount == 0) stringResource(R.string.dash_today_none)
                        else stringResource(R.string.dash_today_sub, stats.todayCount),
                        fontSize = 11.5.sp,
                        color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.75f)
                    )
                }
            }
        }
        item {
            Surface(
                shape = RoundedCornerShape(14.dp),
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(Modifier.padding(14.dp)) {
                    Text(
                        stringResource(R.string.dash_spend_title),
                        fontSize = 12.5.sp, color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.85f)
                    )
                    Text(
                        Dashboard.formatRupees(stats.spentThisMonth),
                        fontSize = 26.sp, fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    Text(
                        stringResource(R.string.dash_spend_sub, stats.spendCount),
                        fontSize = 11.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    if (stats.unparsedTransactions > 0) {
                        Spacer(Modifier.height(4.dp))
                        Text(
                            stringResource(R.string.dash_unparsed, stats.unparsedTransactions),
                            fontSize = 10.5.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
        // Upcoming dues: the other thing with a deadline attached.
        item {
            Text(
                stringResource(R.string.dash_due_title),
                fontSize = 13.sp, fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurface
            )
        }
        if (stats.upcomingDues.isEmpty()) {
            item {
                Text(
                    stringResource(R.string.dash_due_none),
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
        items(stats.upcomingDues) { due -> DueRow(due) }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                StatTile(
                    stringResource(R.string.dash_received),
                    Dashboard.formatRupees(stats.receivedThisMonth),
                    Modifier.weight(1f)
                )
                StatTile(
                    stringResource(R.string.dash_bills),
                    stats.billCount.toString(),
                    Modifier.weight(1f)
                )
            }
        }
        if (reviewReach.first > 0) {
            item {
                Surface(
                    shape = RoundedCornerShape(14.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                    modifier = Modifier.fillMaxWidth().clickable { onOpenReview() }
                ) {
                    Column(Modifier.padding(14.dp)) {
                        Text(
                            stringResource(R.string.dash_needs_you),
                            fontSize = 13.sp, fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                        Text(
                            stringResource(R.string.dash_needs_sub, reviewReach.first, reviewReach.second),
                            fontSize = 11.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
        item {
            Text(
                stringResource(R.string.dash_breakdown),
                fontSize = 13.sp, fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurface
            )
        }
        items(stats.byCategory) { (cat, count) ->
            val share = if (stats.totalMessages > 0) count.toFloat() / stats.totalMessages else 0f
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CategoryChip(cat)
                    Spacer(Modifier.width(10.dp))
                    Text(
                        cat.name.lowercase().replaceFirstChar { it.uppercase() },
                        fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.weight(1f)
                    )
                    Text(
                        count.toString(),
                        fontSize = 12.5.sp, fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Spacer(Modifier.height(4.dp))
                LinearProgressIndicator(
                    progress = { share },
                    modifier = Modifier.fillMaxWidth().height(4.dp),
                    color = MaterialTheme.colorScheme.primary,
                    trackColor = MaterialTheme.colorScheme.surfaceVariant
                )
            }
        }
    }
}

/**
 * One upcoming bill.
 *
 * Leads with when rather than how much, because the deadline is the
 * actionable part — an amount you owe next week and the same amount overdue
 * are different situations. Overdue is coloured as an error rather than
 * hidden, since a lapsed bill is precisely what someone needs to see.
 */
@Composable
private fun DueRow(due: DueDateParser.Due) {
    val days = due.daysFrom(System.currentTimeMillis())
    val overdue = days != null && days < 0
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = if (overdue) MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.35f)
                else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    due.label,
                    fontSize = 13.sp, fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface
                )
                Text(
                    when {
                        days == null -> ""
                        days < 0 -> stringResource(R.string.dash_due_overdue, -days)
                        days == 0 -> stringResource(R.string.dash_due_today)
                        else -> stringResource(R.string.dash_due_in, days)
                    },
                    fontSize = 11.5.sp,
                    color = if (overdue) MaterialTheme.colorScheme.error
                            else MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            due.amount?.let {
                Text(
                    Dashboard.formatRupees(it),
                    fontSize = 15.sp, fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface
                )
            }
        }
    }
}

/**
 * Drill-down for today's spending.
 *
 * Lists the individual transactions behind the headline number, because a
 * total nobody can decompose is a total nobody can check. The correction
 * hint is here rather than buried: the most likely reason a figure looks
 * wrong is a misfiled message, and that is fixable in two taps.
 */
@Composable
private fun TodaySpendDialog(stats: Dashboard.Stats, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.dash_today_title)) },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                Text(
                    Dashboard.formatRupees(stats.spentToday),
                    fontSize = 28.sp, fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary
                )
                Spacer(Modifier.height(10.dp))
                if (stats.todaySpends.isEmpty()) {
                    Text(stringResource(R.string.dash_today_none), fontSize = 13.sp)
                }
                stats.todaySpends.forEach { spend ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                spend.counterparty ?: spend.body.take(40),
                                fontSize = 13.sp,
                                color = MaterialTheme.colorScheme.onSurface,
                                maxLines = 1, overflow = TextOverflow.Ellipsis
                            )
                            Text(
                                formatWhen(spend.at),
                                fontSize = 10.5.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Text(
                            Dashboard.formatRupees(spend.amount),
                            fontSize = 14.sp, fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                    }
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    stringResource(R.string.dash_correct_hint),
                    fontSize = 10.5.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.export_cancel)) }
        }
    )
}

@Composable
private fun StatTile(label: String, value: String, modifier: Modifier = Modifier) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
        modifier = modifier
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(label, fontSize = 11.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                value, fontSize = 20.sp, fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurface
            )
        }
    }
}

@Composable
private fun AboutDialog(onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.about_title)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(stringResource(R.string.about_body), fontSize = 13.sp)
                Spacer(Modifier.height(12.dp))
                Text(
                    stringResource(R.string.about_privacy),
                    fontSize = 12.5.sp, fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary
                )
                Spacer(Modifier.height(12.dp))
                Text(
                    stringResource(R.string.about_version, BuildConfig.VERSION_NAME),
                    fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.export_cancel)) }
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
