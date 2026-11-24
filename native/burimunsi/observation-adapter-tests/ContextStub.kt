package android.content
import android.net.Uri
import android.telephony.SubscriptionManager

/** In-memory provider and permission double. It has no phone or Android storage access. */
class Context {
 val noBackupFilesDir get()=rw.ikanisa.burimunsi.storage.SecureStore.fixtureDirectory
 val applicationContext:Context get()=this
 var denied=emptySet<String>()
 val contentResolver=ContentResolver()
 fun checkSelfPermission(value:String)=if(value in denied)-1 else 0
 @Suppress("UNCHECKED_CAST") fun <T> getSystemService(type:Class<T>):T?=
  if(type==SubscriptionManager::class.java)SubscriptionManager() as T else null
 fun getSharedPreferences(name:String,mode:Int)=Prefs()
 class Prefs{fun getLong(key:String,fallback:Long)=fallback;fun edit()=Editor()}
 class Editor{fun putLong(key:String,value:Long)=this;fun apply()=Unit}
 companion object{const val MODE_PRIVATE=0}
}
class ContentResolver {
 var queries=0
 var cursorRowsRead=0
 var bodyReads=0
 var rows:List<Map<String,Any?>> = emptyList()
 var afterBodyRead:(()->Unit)?=null
 var afterDateRead:(()->Unit)?=null
 var queryAfter:Long?=null
 var querySelection:String?=null
 var rejectFilteredSelection=false
 var ignoreFilteredSelection=false
 var ignoreItemUri=false
 var afterScanQuery:(()->Unit)?=null
 var beforeItemQuery:((Long)->Unit)?=null
 val scanProjections=mutableListOf<List<String>>()
 val itemQueries=mutableListOf<Long>()
 val bodyRowIds=mutableListOf<Long>()
 var unsupportedColumns=emptySet<String>()
 var ignoreDescendingOrder=false
 fun query(uri:Uri,columns:Array<String>,selection:String?,args:Array<String>?,order:String?):FakeCursor {
  queries++
  val item=uri.value.removePrefix("content://sms/inbox/").toLongOrNull()
  if(item!=null){
   itemQueries.add(item);beforeItemQuery?.invoke(item)
   if(columns.any { it in unsupportedColumns }) throw IllegalArgumentException("column unavailable")
   return FakeCursor(rows.filter{ignoreItemUri||it["_id"]==item},columns,this,isItem=true)
  }
  scanProjections.add(columns.toList())
  val selectionSql=checkNotNull(selection);val selectionArgs=checkNotNull(args)
  val after=selectionArgs.first().toLong();queryAfter=after;querySelection=selectionSql
  val filtered=selectionSql.contains("address COLLATE NOCASE")
  if(filtered&&rejectFilteredSelection)throw IllegalArgumentException("selection unavailable")
  if(columns.any { it in unsupportedColumns }) throw IllegalArgumentException("column unavailable")
  val bounded=selectionSql.contains("_id <= ?")
  val end=if(bounded)selectionArgs[1].toLong() else Long.MAX_VALUE
  val senders=selectionArgs.drop(if(bounded)2 else 1)
  val selected=rows.filter{row->
   val address=row["address"] as? String
   (row["_id"] as Long)>after&&(row["_id"] as Long)<=end&&(!filtered||ignoreFilteredSelection||address!=null&&
    (address.any{it !in ' '..'~'}||senders.any{it.equals(address,ignoreCase=true)}))
  }
  val ordered=if(order=="date DESC, _id DESC"&&ignoreDescendingOrder)selected else if(order=="date DESC, _id DESC")selected.sortedWith(compareByDescending<Map<String,Any?>>{(it["date"] as? Number)?.toLong()?:Long.MIN_VALUE}
   .thenByDescending{(it["_id"] as Number).toLong()}) else selected.sortedBy{it["_id"] as Long}
  afterScanQuery?.invoke()
  return FakeCursor(ordered,columns,this)
 }
}
class FakeCursor(private val rows:List<Map<String,Any?>>,private val columns:Array<String>,private val resolver:ContentResolver,private val isItem:Boolean=false):java.io.Closeable {
 private var index=-1
 fun moveToNext():Boolean{index++;return (index<rows.size).also{if(it&&!isItem)resolver.cursorRowsRead++}}
 fun moveToFirst():Boolean{index=0;return rows.isNotEmpty()}
 fun getColumnIndex(name:String)=columns.indexOf(name)
 fun getColumnIndexOrThrow(name:String)=getColumnIndex(name).also{check(it>=0)}
 fun isNull(column:Int)=rows[index][columns[column]]==null
 fun getString(column:Int):String {val key=columns[column];val value=rows[index][key] as String
  if(key=="body"){resolver.bodyReads++;resolver.bodyRowIds.add(rows[index]["_id"] as Long);val action=resolver.afterBodyRead;resolver.afterBodyRead=null;action?.invoke()};return value}
 fun getLong(column:Int):Long {val key=columns[column];val value=(rows[index][key] as Number).toLong()
  if(key=="date"){val action=resolver.afterDateRead;resolver.afterDateRead=null;action?.invoke()};return value}
 fun getInt(column:Int)=(rows[index][columns[column]] as Number).toInt()
 override fun close(){}
}
