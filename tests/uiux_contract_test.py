"""BuriMunsi source, localization, and archived product evidence checks."""
import hashlib,importlib.util,json,pathlib,re,unittest,xml.etree.ElementTree as ET
ROOT=pathlib.Path(__file__).resolve().parents[1]
NATIVE=ROOT/'native/burimunsi'; UI=NATIVE/'app/src/main/kotlin/rw/ikanisa/burimunsi/ui'
CAT=json.loads((ROOT/'contracts/ui-copy.json').read_text());COPY={e['en']:e for e in CAT['entries']}
PROTOTYPE=ROOT/'docs/implementation/burimunsi-android/prototype-reference'
ORIGINAL_MAP=json.loads((PROTOTYPE/'screen-map.json').read_text())
PANEL_BINDINGS={'profile':'PROFILE','change-passcode':'PIN','help':'HELP','allocate':'ALLOCATE',
    'add-member':'ENROLL','staff-list':'STAFF','staff-edit':'STAFF_EDIT','confirm-remove':'REMOVE_STAFF',
    'gateway':'GATEWAY','raw':'RAW','member-details':'MEMBER_DETAILS','history-payment':'HISTORY',
    'audit':'AUDIT','filters':'FILTERS','replace-device':'REPLACE_DEVICE'}
spec=importlib.util.spec_from_file_location('uicopy',ROOT/'scripts/generate_ui_copy.py');generator=importlib.util.module_from_spec(spec);spec.loader.exec_module(generator)
def luminance(hex_colour):
    weights = (0.2126, 0.7152, 0.0722)
    channels = (int(hex_colour[offset:offset + 2], 16) / 255 for offset in (0, 2, 4))
    return sum(
        weight * (channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4)
        for weight, channel in zip(weights, channels)
    )


def contrast(foreground, background):
    dark, light = sorted((luminance(foreground), luminance(background)))
    return (light + 0.05) / (dark + 0.05)


class UiUxContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app_units = {name: (UI/name).read_text() for name in (
            'BuriApp.kt', 'BuriComponents.kt', 'BuriRecordsScreens.kt', 'BuriSmsScreen.kt',
            'BuriAccountScreens.kt', 'BuriSheetHost.kt', 'BuriOperationSheets.kt', 'BuriMemberEnrollmentSheet.kt',
        )}
        cls.app = '\n'.join(cls.app_units.values())
        cls.shell = cls.app_units['BuriApp.kt']
        cls.sheets = cls.app_units['BuriSheetHost.kt']
        cls.behavior = (UI/'UiBehavior.kt').read_text()
        cls.vm = (UI/'BuriViewModel.kt').read_text()
    def test_resources_regenerate_exactly(self):
        for path,text in generator.generated().items():self.assertEqual(path.read_text(),text,str(path))
    def test_both_languages_have_identical_resource_keys(self):
        keys=[]
        for directory in ('values','values-rw'):
            values=ET.parse(NATIVE/f'app/src/main/res/{directory}/ui_strings.xml').getroot()
            keys.append([e.attrib['name'] for e in values]);self.assertTrue(all(e.text for e in values))
        self.assertEqual(keys[0],keys[1]);self.assertEqual(len(keys[0]),len(CAT['entries']))
    def test_catalog_has_unique_phrases_and_placeholder_parity(self):
        self.assertEqual(len(COPY),len(CAT['entries']))
        for e in CAT['entries']:self.assertEqual(sorted(re.findall(r'%\d+\$[sd]',e['en'])),sorted(re.findall(r'%\d+\$[sd]',e['rw'])),e['en'])
    def test_all_financial_presentation_copy_is_localized(self):
        source=(NATIVE/'core/src/main/kotlin/rw/ikanisa/burimunsi/core/Presentation.kt').read_text()
        for phrase in re.findall(r'"([A-Z][^"\n]+)"',source):self.assertIn(phrase,COPY)
    def test_all_receiving_phone_diagnostics_are_localized(self):
        source=(NATIVE/'core/src/main/kotlin/rw/ikanisa/burimunsi/core/GatewayHealth.kt').read_text()
        for phrase in re.findall(r'"([A-Z][^"\n]+)"',source):self.assertIn(phrase,COPY)
    def test_controller_error_copy_is_localized(self):
        # Fixed audited API payloads are not user-facing copy and must not be translated.
        audit_purposes={'Review original SMS from the selected contribution or receipt','Automatic SMS list preview'}
        self.assertIn('if(sheet==Sheet.RAW)loadRawForCurrentPanel("Review original SMS from the selected contribution or receipt")',self.vm)
        inbox = (UI/'NativeSmsInboxScan.kt').read_text()
        self.assertIn('val reason = "Automatic SMS list preview"', inbox)
        self.assertIn('is SmsSourceRef.Canonical -> repository().raw(source.id, reason)', inbox)
        self.assertIn('is SmsSourceRef.Observation -> repository().revealObservation(source, reason)', inbox)
        sources = (
            ('BuriViewModel.kt', self.vm),
            ('NativeListingDownloads.kt', (UI/'NativeListingDownloads.kt').read_text()),
            ('NativeSmsDisclosure.kt', (UI/'NativeSmsDisclosure.kt').read_text()),
            ('NativeSmsInboxScan.kt', inbox),
        )
        for name, source in sources:
            for phrase in re.findall(r'"([A-Z][^"\n]+)"', source):
                if ' ' in phrase and '$' not in phrase and phrase not in audit_purposes:
                    self.assertIn(phrase, COPY, f'{name}: {phrase}')
    def test_restored_original_ui_copy_is_localized(self):
        for name,source in list(self.app_units.items())+[(name,(UI/name).read_text()) for name in ('UiFeedback.kt','UiListingTools.kt','UiPreferences.kt')]:
            for literal in re.findall(r'\bt\(\s*("(?:[^"\\]|\\.)*")',source):
                phrase=json.loads(literal.replace('\\$','$'))
                self.assertIn(phrase,COPY,name+': '+phrase)
        # Static alternatives rendered through t(if...), t(rawError), and the status select.
        for phrase in ('Admin','Staff','Gateway','Pair receiver','Create staff','Save changes','Disable','Enable',
            'All messages are synced.','Try another search.','Original SMS unavailable.',
            'Verified','Changed · sync blocked','Required','Granted','Blocked','Listening','Paused','Pause','Resume',
            'All','Allocated','Unallocated','Processing'):
            self.assertIn(phrase,COPY,phrase)
    def test_direct_text_literals_are_brand_or_decorative(self):
        brands={'BuriMunsi','BuriMunsi · Collect'}
        # This icon is decorative and explicitly removed from accessibility semantics.
        self.assertIn('Text("+",Modifier.clearAndSetSemantics{}',self.app)
        self.assertLessEqual(set(re.findall(r'\bText\("([^"\n]+)"',self.app)),brands|{'+'})
    def test_sanitized_prototype_reference_is_byte_exact(self):
        provenance=json.loads((PROTOTYPE/'provenance.json').read_text())
        self.assertEqual(provenance['prototype_name'],'BuriMunsi_Prototype_v1.1.0.html')
        for item in provenance['files']:
            data=(PROTOTYPE/item['path']).read_bytes()
            self.assertEqual(len(data),item['bytes'])
            self.assertEqual(hashlib.sha256(data).hexdigest(),item['sha256'])
        prototype=next(item for item in provenance['files'] if item['path']=='index.html')
        self.assertEqual(prototype['sha256'], '3f2d159b139f1e39adb96bfafe739d044bb9ebfd836cc9c15d73d009b0744a97')
        self.assertEqual(prototype['original_sha256'], '644c0ca7dfa38ee184a80be7d0e0d753503fa40dac00ae1814a9359b5e9fba4d')
    def test_original_phone_pin_entry_has_no_added_onboarding_screen(self):
        activity=(NATIVE/'app/src/main/kotlin/rw/ikanisa/burimunsi/MainActivity.kt').read_text()
        self.assertIn('BuriApp(',activity)
        for added in ('PhoneSetup(', 'CollectSignIn(', 'InstallationSetupDetails('):
            self.assertNotIn(added,activity)
            self.assertNotIn('fun '+added,self.app)
    def test_raw_evidence_and_names_are_not_sent_to_translation(self):
        for value in ('raw.body','raw.sender','raw.at','p.ftId','p.payerNameRaw','p.payerPhoneRaw','p.atRaw','sms.preview','member.name','member.phone'):
            self.assertNotIn('t('+value+')',self.app)
        self.assertIn('SelectionContainer{Text(raw.body',self.app)
    def test_supported_languages_are_explicit(self):
        root=ET.parse(NATIVE/'app/src/main/res/xml/locales_config.xml').getroot()
        self.assertEqual({e.attrib['{http://schemas.android.com/apk/res/android}name'] for e in root},{'en','rw'})
    def test_display_preferences_never_store_operator_data(self):
        source=(UI/'UiPreferences.kt').read_text()
        self.assertEqual(set(re.findall(r'put(?:String|Boolean)\("([^"]+)"',source)),{'language','reduce-screen-motion'})
    def test_navigation_store_uses_existing_encrypted_boundary(self):
        source=(NATIVE/'app/src/main/kotlin/rw/ikanisa/burimunsi/storage/AndroidNavigationCheckpointStore.kt').read_text()
        self.assertIn('SecureStore(context, "ui-navigation")',source);self.assertNotIn('getSharedPreferences(',source)
    def test_no_sensitive_saveable_state(self):
        self.assertNotIn('rememberSaveable',self.app);self.assertNotIn('SavedStateHandle',self.vm)
        self.assertIn('state.selectedMember',self.vm);self.assertIn('draft=emptyMap()',self.vm)
    def test_all_original_routes_are_rendered(self):
        body=self.shell.split('RouteEntrance(t(titleFor(s.route))){when(s.route){',1)[1].split('}}}',1)[0]
        expected={screen['route'].upper() for screen in ORIGINAL_MAP['screens']}
        self.assertEqual(set(re.findall(r'Route\.(\w+)->',body)),expected)
    def test_all_original_panels_are_rendered(self):
        panel_body=self.sheets.split('key(sheet,s.sheetId){when(sheet)',1)[1].split('@Composable private fun DiscardPrompt',1)[0]
        expected={panel for screen in ORIGINAL_MAP['screens'] for panel in screen['panels']}
        self.assertEqual(set(PANEL_BINDINGS),expected)
        self.assertEqual(set(re.findall(r'Sheet\.(\w+)->',panel_body)),{PANEL_BINDINGS[x] for x in expected})
    def test_reduced_motion_does_not_keep_outgoing_records(self):
        self.assertIn('progress.snapTo(1f)',self.behavior);self.assertIn('tween(160)',self.behavior)
        self.assertNotIn('Crossfade(',self.behavior);self.assertNotIn('AnimatedContent(',self.behavior)
    def test_ime_chains_and_secret_disposal_are_explicit(self):
        self.assertIn('nextFocus.requestFocus()',self.app);self.assertIn('Key.NumPadEnter',self.app)
        self.assertIn('if(imeVisible){keyboard?.hide();focus.clearFocus()}',self.app)
        self.assertIn('pin=""',self.app);self.assertIn('current="";next="";confirm=""',self.app)
    def test_signin_has_no_undefined_pending_variable(self):
        login=self.app_units['BuriAccountScreens.kt'].split('fun Login(',1)[1].split('@Composable',1)[0]
        self.assertNotIn('pending',login)
    def test_modal_dirty_dismissal_is_vetoed(self):
        self.assertIn('confirmValueChange={target->',self.sheets)
        self.assertIn('latest.value.busy||latest.value.draftDirty',self.sheets)
        self.assertIn('rememberLazyListState(position.first,position.second)',self.app_units['BuriComponents.kt'])
    def test_financial_amounts_fit_and_remain_scrollable(self):
        components = self.app_units['BuriComponents.kt']
        amount = components.split('fun MoneyText(', 1)[1].split('@Composable', 1)[0]
        self.assertIn('Presentation.MONEY_MIN_SP', amount)
        self.assertIn('density.fontScale', amount)
        self.assertIn('fontFeatureSettings="tnum"', amount)
        self.assertIn('horizontalScroll(scroll)', amount)
        self.assertIn('contentDescription="$full RWF"', amount)

    def test_records_stack_on_narrow_screens_and_at_larger_text_sizes(self):
        records = self.app_units['BuriRecordsScreens.kt']
        for row in ('PaymentRow', 'MemberRow', 'LedgerRowView'):
            with self.subTest(row=row):
                source = records.split(f'fun {row}(', 1)[1].split('@Composable', 1)[0]
                self.assertRegex(
                    source,
                    r'val stacked\s*=\s*maxWidth\s*<\s*\d+\.dp\s*\|\|\s*'
                    r'(?:LocalDensity\.current\.)?fontScale\s*>=\s*[\d.]+f',
                )
                self.assertIn('if(stacked)', source)

    def test_utility_text_contrast_remains_at_least_45(self):
        theme = (UI / 'Theme.kt').read_text()
        colours = dict(re.findall(r'val (\w+)\s*=\s*Color\(0xFF([0-9A-F]{6})\)', theme))
        utility = re.search(
            r'else\s*->\s*BuriRouteColors\(Color\(0xFF([0-9A-F]{6})\),'
            r'\s*Color\(0xFF([0-9A-F]{6})\),', theme,
        )
        self.assertIsNotNone(utility, 'Utility foreground colors')
        colours['Muted'], colours['Blue'] = utility.groups()
        for name in ('Text', 'Muted', 'Blue', 'Good', 'Warn', 'Bad'):
            for background in ('Canvas', 'Surface', 'Raised'):
                with self.subTest(foreground=name, background=background):
                    self.assertGreaterEqual(contrast(colours[name], colours[background]), 4.5)

    def test_twelve_controller_journeys_have_distinct_ids(self):
        source=(NATIVE/'viewmodel-tests/JourneyChecks.kt').read_text()
        self.assertEqual(re.findall(r'journey\("(J\d+)"',source),[f'J{i:02}' for i in range(1,13)])
    def test_instrumentation_is_not_in_shipping_source(self):
        for p in (NATIVE/'app/src/main').rglob('*.kt'):self.assertNotIn('FakeController',p.read_text())
if __name__=='__main__':unittest.main()
