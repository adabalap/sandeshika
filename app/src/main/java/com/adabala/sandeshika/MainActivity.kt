package com.adabala.sandeshika

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
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
        messages = withContext(Dispatchers.IO) { SmsReader.read(context) }
    }

    val all = messages
    val shown = remember(all, selectedTab) {
        all?.filter { it.classification.category in selectedTab.categories }.orEmpty()
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
                shown.isEmpty() -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Text(
                        stringResource(R.string.empty_tab),
                        color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 14.sp
                    )
                }
                else -> LazyColumn(
                    contentPadding = PaddingValues(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    items(shown) { MessageCard(it) }
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

@Composable
private fun MessageCard(item: ClassifiedSms) {
    val cat = item.classification.category
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f),
        tonalElevation = 0.dp,
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CategoryChip(cat)
                Spacer(Modifier.width(8.dp))
                Text(
                    item.displaySender,
                    fontSize = 12.5.sp, fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                Text(
                    formatWhen(item.sms.receivedAt),
                    fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Spacer(Modifier.height(6.dp))
            Text(
                item.sms.body,
                fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface,
                maxLines = 4, overflow = TextOverflow.Ellipsis
            )
            // The reasoning is shown, not hidden behind a long-press. A
            // category you disagree with is worth little if you cannot see
            // what produced it, and this is what makes a correction
            // meaningful later rather than just a patch.
            Spacer(Modifier.height(6.dp))
            Text(
                item.classification.why +
                    if (!item.classification.confident) " · low confidence" else "",
                fontSize = 10.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
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
