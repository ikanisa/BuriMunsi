package android.content

class Context {
    val applicationContext:Context get()=this
    val contentResolver=ContentResolver()
    fun checkSelfPermission(permission:String)=android.content.pm.PackageManager.PERMISSION_GRANTED
    fun getSystemService(name:String):Any?=null
    companion object { const val TELEPHONY_SERVICE="phone" }
}
class ContentResolver {
    fun query(uri:Any,projection:Array<String>?,selection:String?,args:Array<String>?,order:String): TestCursor {
        val after=args?.firstOrNull()?.toLongOrNull()?:0L
        return TestCursor(app.cool.mobile.receiver_sms.CaptureFixture.inbox.filter{(it.getValue("_id") as Long)>after})
    }
}
class TestCursor(private val rows:List<Map<String,Any?>>):AutoCloseable {
    private val columns=listOf("_id","address","body","date","date_sent","sub_id")
    private var index=-1
    fun moveToNext():Boolean { index++; return index<rows.size }
    fun moveToFirst():Boolean { index=0; return rows.isNotEmpty() }
    fun getColumnIndex(name:String)=columns.indexOf(name)
    fun getColumnIndexOrThrow(name:String)=getColumnIndex(name).also{check(it>=0)}
    private fun value(column:Int)=rows[index][columns[column]]
    fun getString(column:Int)=value(column) as? String
    fun getLong(column:Int)=(value(column) as? Number)?.toLong()?:0L
    fun getInt(column:Int)=getLong(column).toInt()
    fun isNull(column:Int)=value(column)==null
    override fun close()=Unit
}
class Bundle(private val values:Map<String,Any?>) { operator fun get(key:String)=values[key] }
class Intent(val action:String?,private val values:Map<String,Any?> = emptyMap()) {
    val extras:Bundle get()=Bundle(values)
    fun hasExtra(key:String)=values.containsKey(key)
    fun getIntExtra(key:String,default:Int)=(values[key] as? Int)?:default
    fun getStringExtra(key:String)=values[key] as? String
}
open class BroadcastReceiver {
    open fun onReceive(context:Context,intent:Intent){}
    fun goAsync()=PendingResult()
    class PendingResult { fun finish(){app.cool.mobile.receiver_sms.CaptureFixture.finished++} }
}
